// JVM Architecture Visualizer Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { enrichTrace } = require('./dryRunEnricher');
const { generateCustomVisualizer } = require('./aiVisualizer');

const app = express();

// Trust the AWS Application Load Balancer (ALB) proxy so express-rate-limit doesn't crash on X-Forwarded-For headers
app.set('trust proxy', 1);

// --- SECURITY: CORS origin allowlist ---
// Only permit requests from our known frontend origins.
const ALLOWED_ORIGINS = [
  'https://javaflow.vercel.app',
  'https://jvm-visualizer.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

// Custom CORS Middleware to handle all CORS and Preflight logic
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Set Allow-Origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // For non-browser clients (curl) or mismatched origins, we don't set Origin
    // but we can default to '*' if you want, or just omit it.
    res.header('Access-Control-Allow-Origin', '*'); 
  }

  // Set other CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key, Origin, Accept');
  res.header('Access-Control-Expose-Headers', 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours

  // Preflight request (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: '50mb' }));

// --- SECURITY: CSRF guard ---
// Reject state-changing POST requests that don't come from the browser fetch API
// (i.e., don't have Content-Type: application/json). This blocks cross-origin
// form submissions (the primary CSRF attack vector) without requiring session state.
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({ ok: false, message: 'Unsupported Media Type: Content-Type must be application/json' });
    }
  }
  next();
});

// --- SECURITY: API Key Authentication ---
// Protects all /api/* POST endpoints from unauthorized access.
// The frontend must send: X-API-Key: <APP_API_KEY>
// Health-check endpoints (GET /, /health, /healthz, /api/health) remain public.
const PROTECTED_POST_PATHS = ['/api/execute', '/api/dry-run', '/api/ai-visualize', '/api/ai-visualize/regenerate'];
const APP_API_KEY = process.env.APP_API_KEY;
if (!APP_API_KEY) {
  console.warn('[SECURITY WARNING] APP_API_KEY is not set in .env. All API endpoints are unauthenticated!');
}

app.use((req, res, next) => {
  // Only enforce auth on protected POST endpoints
  if (!PROTECTED_POST_PATHS.includes(req.path) || req.method !== 'POST') {
    return next();
  }
  // Skip auth check if key is not configured (backward compat for local dev)
  if (!APP_API_KEY) return next();

  const providedKey = req.headers['x-api-key'] || '';
  // Timing-safe comparison prevents timing attacks
  const expected = Buffer.from(APP_API_KEY, 'utf8');
  const provided = Buffer.from(providedKey, 'utf8');
  const match = expected.length === provided.length &&
    require('crypto').timingSafeEqual(expected, provided);

  if (!match) {
    return res.status(401).json({ ok: false, message: 'Unauthorized: Invalid or missing API key.' });
  }
  next();
});


// 1. Global limit for general endpoints (health checks, etc)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: { ok: false, message: 'Too many requests overall. Please try again later.' },
  standardHeaders: false,
  legacyHeaders: false,
});
app.use(globalLimiter);

// 2. Execution limit for Java tracing
const executionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { ok: false, type: 'rate_limit', message: 'Execution rate limit exceeded (10 per minute).' },
});

// 3. AI Generation limit (Short-term burst protection)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  standardHeaders: false,
  legacyHeaders: false,
  message: { ok: false, type: 'rate_limit', message: 'AI generation limit exceeded (3 per minute).' },
});

// 4. AI Generation limit (Initial)
const dailyAiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 11, // Max 11 new generations per IP per day
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET',
  message: { ok: false, type: 'rate_limit_daily', message: 'Daily AI generation limit reached (11 per day). Please try again tomorrow.' },
});

// 5. AI Regeneration limit (Retries)
const dailyRegenLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5, // Max 5 regenerations per IP per day
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET',
  message: { ok: false, type: 'rate_limit_regen', message: 'Daily AI regeneration limit reached (5 per day). Please try again tomorrow.' },
});

app.post('/api/execute', executionLimiter, (req, res) => {
  const { code } = req.body;
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'No code provided.' });
  }
  
  const tempDir = __dirname;
  const javaFile = path.join(tempDir, 'Main.java');
  
  // Prepend universal imports on the same line so line numbers are not shifted
  const universalImports = "import java.util.*; import java.io.*; import java.math.*; import java.time.*; ";
  const finalCode = universalImports + code;
  
  fs.writeFileSync(javaFile, finalCode);

  const runTrace = () => {
    // 1. Run TraceGenerator in serverless mode (compiles, extracts bytecode, and traces in a single JVM)
    // --- SECURITY NOTE ---
    // Java SecurityManager was removed in Java 21. Primary sandbox isolation
    // is now provided by Docker --security-opt no-new-privileges + seccomp (see Dockerfile).
    exec(`java TraceGenerator --serverless Main`, { cwd: tempDir, maxBuffer: 1024 * 1024 * 50, timeout: 30000 }, (err, stdout, stderr) => {
      let trace = null;
      let bytecode = "Failed to extract bytecode.";
      let salvageWarning = '';
    
    if (stdout && stdout.trim().startsWith('{')) {
      try {
        let salvaged = stdout.trim();
        // The serverless output is a single JSON object: { "bytecode": "...", "trace": [ ... ] }
        if (!salvaged.endsWith('}')) {
           // Basic salvage attempt if truncated
           salvaged += '\n  ]\n}';
        }
        const parsed = JSON.parse(salvaged);
        trace = parsed.trace;
        bytecode = parsed.bytecode;
      } catch(e) {
        salvageWarning = '\n[Visualizer Note: Failed to parse trace.]';
      }
    }
    
    if (err && !trace) {
      const errMsg = stderr ? stderr : (err.message || 'Unknown Execution Error');
      return res.status(200).json({ error: 'Execution Error:\n' + errMsg + salvageWarning, bytecode });
    }
    
    if (!trace) {
       return res.status(200).json({ error: 'Failed to parse trace from Java helper:\n' + stdout, bytecode });
    }
    
    res.json({ trace, bytecode, error: err ? ('Execution Warning:\n' + (stderr || err.message)) : null });
    });
  };

  if (!fs.existsSync(path.join(tempDir, 'TraceGenerator.class'))) {
    console.log("TraceGenerator.class not found. Compiling...");
    exec(`javac -g TraceGenerator.java`, { cwd: tempDir }, (err, stdout, stderr) => {
      if (err) {
        return res.status(200).json({ error: 'Backend Setup Error:\n' + stderr });
      }
      runTrace();
    });
  } else {
    runTrace();
  }
});

app.post('/api/dry-run', executionLimiter, (req, res) => {
  const { sourceCode } = req.body;
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
    return res.status(400).json({ ok: false, type: 'input_error', message: 'No source code provided.' });
  }

  const tempDir = __dirname;
  
  // Extract class name containing main method, default to Main
  const mainMatch = sourceCode.match(/class\s+(\w+)[^{]*\{[\s\S]*?public\s+static\s+void\s+main/);
  const rawClassName = mainMatch ? mainMatch[1] : 'Main';

  // --- SECURITY: Path Traversal Fix ---
  // Strictly validate the class name: must start with uppercase letter,
  // contain only valid Java identifier characters, and be <= 64 chars.
  // This prevents path traversal attacks like '../../etc/passwd'.
  const CLASSNAME_REGEX = /^[A-Z][a-zA-Z0-9_]{0,63}$/;
  if (!CLASSNAME_REGEX.test(rawClassName)) {
    return res.status(400).json({
      ok: false,
      type: 'input_error',
      message: `Invalid class name '${rawClassName}'. Class names must start with an uppercase letter and contain only letters, digits, or underscores.`,
    });
  }
  const mainClassName = rawClassName;

  const javaFile = path.join(tempDir, `${mainClassName}.java`);
  const universalImports = "import java.util.*; import java.io.*; import java.math.*; import java.time.*;\n";
  const finalCode = universalImports + sourceCode;

  fs.writeFileSync(javaFile, finalCode);

  const runDryRun = () => {
    // --- SECURITY NOTE ---
    // Java SecurityManager was removed in Java 21. Primary sandbox isolation
    // is now provided by Docker --security-opt no-new-privileges + seccomp (see Dockerfile).
    exec(`java TraceGenerator --serverless ${mainClassName}`, { cwd: tempDir, maxBuffer: 1024 * 1024 * 50, timeout: 30000 }, (err, stdout, stderr) => {
      let rawTrace = null;
      let bytecode = '';

      if (stdout && stdout.trim().startsWith('{')) {
        try {
          let salvaged = stdout.trim();
          if (!salvaged.endsWith('}')) salvaged += '\n  ]\n}';
          const parsed = JSON.parse(salvaged);
          rawTrace = parsed.trace;
          bytecode = parsed.bytecode || '';
        } catch (e) {
          // parse failed
        }
      }

      if (!rawTrace) {
        const errMsg = stderr || (err && err.message) || stdout || 'Unknown execution error';
        // Try to detect compile errors
        const isCompileError = errMsg.includes('error:') || errMsg.includes('cannot find symbol');
        const lineMatch = errMsg.match(/\.java:(\d+):/);
        return res.json({
          ok: false,
          type: isCompileError ? 'compile_error' : 'runtime_error',
          message: errMsg,
          line: lineMatch ? parseInt(lineMatch[1]) : null,
        });
      }

      // Enrich raw trace into DryRunStep[]
      const enrichedTrace = enrichTrace(rawTrace);

      // Detect complexity from trace metrics
      const lastStep = enrichedTrace[enrichedTrace.length - 1];
      const totalOps = lastStep?.metrics?.operations || enrichedTrace.length;
      const maxStack = lastStep?.metrics?.maxStackDepth || 1;

      res.json({
        ok: true,
        language: 'java',
        trace: enrichedTrace,
        bytecode,
        complexity: {
          measuredOps: totalOps,
          maxStackDepth: maxStack,
          traceSteps: enrichedTrace.length,
        },
      });
    });
  };

  if (!fs.existsSync(path.join(tempDir, 'TraceGenerator.class'))) {
    exec(`javac -g TraceGenerator.java`, { cwd: tempDir }, (err, stdout, stderr) => {
      if (err) return res.json({ ok: false, type: 'setup_error', message: stderr });
      runDryRun();
    });
  } else {
    runDryRun();
  }
});

app.post('/api/ai-visualize', dailyAiLimiter, aiLimiter, async (req, res) => {
  const { sourceCode, trace } = req.body;
  if (!sourceCode || typeof sourceCode !== 'string') {
    return res.status(400).json({ ok: false, message: 'Source code is required' });
  }

  try {
    const result = await generateCustomVisualizer({
      sourceCode,
      trace: Array.isArray(trace) ? trace : [],
      forceRegenerate: false
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('AI visualize error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to generate visualizer' });
  }
});

app.post('/api/ai-visualize/regenerate', dailyRegenLimiter, aiLimiter, async (req, res) => {
  const { sourceCode, trace } = req.body;
  if (!sourceCode || typeof sourceCode !== 'string') {
    return res.status(400).json({ ok: false, message: 'Source code is required' });
  }

  try {
    const result = await generateCustomVisualizer({
      sourceCode,
      trace: Array.isArray(trace) ? trace : [],
      forceRegenerate: true
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('AI visualize error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to regenerate visualizer' });
  }
});

app.post('/api/admin/reset-limits', (req, res) => {
  const { code } = req.body;
  if (!process.env.ADMIN_SECRET_CODE) {
    return res.status(500).json({ ok: false, message: 'ADMIN_SECRET_CODE not configured on server' });
  }
  if (code !== process.env.ADMIN_SECRET_CODE) {
    return res.status(401).json({ ok: false, message: 'Invalid admin code' });
  }

  const key = req.ip || req.socket.remoteAddress || '127.0.0.1';
  
  try {
    dailyAiLimiter.resetKey(key);
    dailyRegenLimiter.resetKey(key);
    aiLimiter.resetKey(key);
    executionLimiter.resetKey(key);
    globalLimiter.resetKey(key);
    res.json({ ok: true, message: 'Rate limits successfully reset for your IP!' });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Failed to reset limit: ' + e.message });
  }
});

app.get('/api/rate-limit-status', async (req, res) => {
  try {
    const key = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const record = await dailyAiLimiter.store.get(key);
    const totalHits = record ? record.totalHits : 0;
    const remaining = Math.max(0, 11 - totalHits);
    res.json({ ok: true, remaining });
  } catch (e) {
    res.json({ ok: true, remaining: 11 });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'JVM Architecture Visualizer API is running' }));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/health', (req, res) => res.json({ ok: true, status: 'ok' }));

const PORT = process.env.PORT || 80;
const server = app.listen(PORT, () => console.log(`JVM Visualizer API running on http://localhost:${PORT}`));

// Also listen on port 80 if PORT is set to 4000, so AWS ALB target group health checks always pass
if (Number(PORT) !== 80) {
  try {
    const http = require('http');
    const server80 = http.createServer(app);
    server80.on('error', (err) => {
      // Gracefully ignore if port 80 is unavailable or in use locally
    });
    server80.listen(80, () => {
      console.log(`JVM Visualizer API also listening on port 80 for AWS ALB`);
    });
  } catch (e) {}
}
