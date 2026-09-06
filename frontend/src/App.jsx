import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from './components/CodeEditor.jsx';
import MethodAreaView from './components/MethodAreaView.jsx';
import HeapView from './components/HeapView.jsx';
import ThreadsView from './components/ThreadsView.jsx';
import CallStackView from './components/CallStackView.jsx';
import PCRegisterView from './components/PCRegisterView.jsx';
import ConsoleView from './components/ConsoleView.jsx';
import TutorView from './components/TutorView.jsx';
import BytecodeView from './components/BytecodeView.jsx';
import InfoModal from './components/InfoModal.jsx';
import AboutModal from './components/AboutModal.jsx';
import ComplexityView from './components/ComplexityView.jsx';
import MobileNotice from './components/MobileNotice.jsx';
import ExecutionErrorNotice from './components/ExecutionErrorNotice.jsx';
import DryRunView from './features/dry-run/components/DryRunView.jsx';
import { inferBigO, computeMetrics } from './utils/complexityAnalyzer.js';
import { validateJavaCode } from './utils/languageDetector.js';
import { EXAMPLES, DEFAULT_EXAMPLE } from './examples.js';
import { API_BASE, authHeaders } from './config/api.js';
import AdminResetView from './components/AdminResetView.jsx';

export default function App() {
  const [isAdminRoute] = useState(() => window.location.pathname === '/admin/reset');

  if (isAdminRoute) {
    return <AdminResetView />;
  }

  // Memory State
  const [memoryExample, setMemoryExample] = useState(DEFAULT_EXAMPLE);
  const [memoryCode, setMemoryCode] = useState(EXAMPLES[DEFAULT_EXAMPLE]);
  const [memoryBytecode, setMemoryBytecode] = useState('');
  const [memoryTrace, setMemoryTrace] = useState([]);

  // Complexity State
  const [complexityExample, setComplexityExample] = useState('Default');
  const [complexityCode, setComplexityCode] = useState('');
  const [complexityBytecode, setComplexityBytecode] = useState('');
  const [complexityTrace, setComplexityTrace] = useState([]);
  
  // Independent playback states for Memory and Complexity views
  const [memoryIndex, setMemoryIndex] = useState(0);
  const [memoryPlaying, setMemoryPlaying] = useState(false);
  const [complexityIndex, setComplexityIndex] = useState(0);
  const [complexityPlaying, setComplexityPlaying] = useState(false);
  const [activeView, setActiveView] = useState(() => localStorage.getItem('activeView') || 'memory');
  const [activeTab, setActiveTab] = useState('source');
  const [switchPrompt, setSwitchPrompt] = useState(null);

  // Aliases for the currently active view
  const exampleName = activeView === 'memory' ? memoryExample : complexityExample;
  const setExampleName = activeView === 'memory' ? setMemoryExample : setComplexityExample;
  const code = activeView === 'memory' ? memoryCode : complexityCode;
  const setCode = activeView === 'memory' ? setMemoryCode : setComplexityCode;
  const bytecode = activeView === 'memory' ? memoryBytecode : complexityBytecode;
  const setBytecode = activeView === 'memory' ? setMemoryBytecode : setComplexityBytecode;
  const trace = activeView === 'memory' ? memoryTrace : complexityTrace;
  const setTrace = activeView === 'memory' ? setMemoryTrace : setComplexityTrace;

  const index = activeView === 'memory' ? memoryIndex : complexityIndex;
  const setIndex = activeView === 'memory' ? setMemoryIndex : setComplexityIndex;
  const playing = activeView === 'memory' ? memoryPlaying : complexityPlaying;
  const setPlaying = activeView === 'memory' ? setMemoryPlaying : setComplexityPlaying;
  const [speed, setSpeed] = useState(1200);
  const [error, setError] = useState(null);
  const [infoModal, setInfoModal] = useState(null);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);
  const timerRef = useRef(null);

  // Compute Big-O and runtime metrics (memoized — only recomputes when code/trace changes)
  const bigO = useMemo(() => inferBigO(code), [code]);
  const metrics = useMemo(() => computeMetrics(trace), [trace]);

  const current = trace[index] || null;

  async function runCode() {
    const langCheck = validateJavaCode(code);
    if (!langCheck.isSupported) {
      setError(langCheck.message);
      return;
    }

    setLoading(true);
    setError(null);
    setMemoryPlaying(false);
    setComplexityPlaying(false);
    setTrace([]);
    setBytecode('');
    setMemoryIndex(0);
    setComplexityIndex(0);
    setActiveTab('source');
    if (isEditorExpanded) setIsEditorExpanded(false);
    try {
      const res = await fetch(`${API_BASE}/api/execute`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (data.bytecode) setBytecode(data.bytecode);
      
      if (data.error) {
        setError(data.error);
        if (data.trace) setTrace(data.trace);
      } else {
        setTrace(data.trace);
      }
    } catch (e) {
      setError('Could not reach backend at ' + API_BASE + '/api/execute');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!loading && !error && trace.length > 0) {
      setPlaying(true);
    }
  }, [loading, error, trace.length]);

  useEffect(() => {
    if (!playing) { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => {
      setIndex((i) => {
        if (i >= trace.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, speed);
    return () => clearInterval(timerRef.current);
  }, [playing, speed, trace.length, activeView]);

  function handleExampleChange(name) {
    setExampleName(name);
    setCode(EXAMPLES[name] || '');
    setTrace([]);
    setIndex(0);
    setError(null);
  }

  // Force sync mechanism for DryRunView
  const [dryRunSyncCode, setDryRunSyncCode] = useState(null);

  function handleViewSwitch(targetView) {
    if (targetView === activeView) return;

    if (activeView === 'dry-run' || targetView === 'dry-run') {
      setActiveView(targetView);
      localStorage.setItem('activeView', targetView);
      return;
    }
    
    const currentCode = activeView === 'memory' ? memoryCode : complexityCode;
    const targetCode = targetView === 'memory' ? memoryCode : complexityCode;
    
    if (currentCode === targetCode || currentCode.trim() === '') {
      setActiveView(targetView);
      localStorage.setItem('activeView', targetView);
      return;
    }

    setSwitchPrompt({ type: 'sync', target: targetView });
  }

  function confirmSwitch(action) {
    if (!switchPrompt) return;
    const targetView = switchPrompt.target;

    if (switchPrompt.type === 'leave-dry-run') {
      if (action === 'discard') {
        setDryRunSyncCode(EXAMPLES[DEFAULT_EXAMPLE] || '');
      }
      setActiveView(targetView);
      localStorage.setItem('activeView', targetView);
      setSwitchPrompt(null);
      return;
    }

    if (action === 'sync') {
      const currentCode = activeView === 'memory' ? memoryCode : complexityCode;
      const currentTrace = activeView === 'memory' ? memoryTrace : complexityTrace;
      const currentBytecode = activeView === 'memory' ? memoryBytecode : complexityBytecode;

      if (targetView === 'complexity') {
        setComplexityCode(currentCode);
        setComplexityTrace(currentTrace);
        setComplexityBytecode(currentBytecode);
        setComplexityIndex(0);
      } else {
        setMemoryCode(currentCode);
        setMemoryTrace(currentTrace);
        setMemoryBytecode(currentBytecode);
        setMemoryIndex(0);
      }
    } else if (action === 'fresh') {
      if (targetView === 'complexity') {
        setComplexityCode('');
        setComplexityTrace([]);
        setComplexityBytecode('');
        setComplexityIndex(0);
        setComplexityExample('Default');
      } else {
        setMemoryCode('');
        setMemoryTrace([]);
        setMemoryBytecode('');
        setMemoryIndex(0);
        setMemoryExample('Default');
      }
    }
    setActiveView(targetView);
    localStorage.setItem('activeView', targetView);
    setSwitchPrompt(null);
  }

  function handleCodeChange(newCode) {
    setCode(newCode);
    if (exampleName !== 'Default' && newCode !== EXAMPLES[exampleName]) {
      setExampleName('Default');
    }
  }

  const activeThread = current?.threads ? Object.values(current.threads).find(t => t.id === current.threadId) : null;
  const activeLine = activeThread?.callStack?.slice(-1)[0]?.line || null;

  const total = trace.length;
  const progressPercent = total > 0 ? (index / (total - 1)) * 100 : 0;

  return (
    <div style={{ '--speed-mult': speed / 1200 }} className="flex flex-col h-screen w-screen overflow-hidden bg-surface-container-lowest">
      <nav className="flex justify-between items-center w-full px-3 sm:px-5 h-14 z-50 bg-surface border-b border-border-subtle shrink-0 gap-2">
        {/* LEFT: Logo + Example Selector */}
        <div className="flex items-center gap-2.5 sm:gap-4 shrink-0">
          <button onClick={() => setIsAboutModalOpen(true)} className="flex items-center outline-none hover:opacity-80 transition-opacity" title="About JavaFlow">
            <img src="/logo-full.png" alt="JavaFlow Logo" className="h-8 sm:h-9 w-auto object-contain" />
          </button>
          {activeView !== 'dry-run' && (
            <select 
              className="bg-surface-container text-on-surface border border-border-subtle px-2.5 py-1 rounded-lg text-[12px] outline-none cursor-pointer hover:border-outline transition-colors shrink-0"
              value={exampleName} 
              onChange={(e) => handleExampleChange(e.target.value)}
            >
              {Object.keys(EXAMPLES).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
        </div>
        
        {/* CENTER: Step Controls & Progress */}
        {activeView !== 'dry-run' && (
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 mx-1 sm:mx-2">
            <button onClick={() => { setIndex(0); setPlaying(false); }} className="text-on-surface-variant hover:text-on-surface w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-container-high transition-colors shrink-0" title="Reset to Start">
              <span className="material-symbols-outlined text-[18px]">skip_previous</span>
            </button>
            <button onClick={() => setIndex(i => Math.max(0, i - 1))} className="text-on-surface-variant hover:text-on-surface w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-container-high transition-colors shrink-0" title="Step Back">
              <span className="material-symbols-outlined text-[18px]">navigate_before</span>
            </button>
            <button onClick={() => setPlaying(p => !p)} className="bg-primary/10 text-primary hover:bg-primary/20 rounded-full w-8 h-8 flex items-center justify-center transition-colors shrink-0" title={playing ? 'Pause' : 'Play'}>
              <span className="material-symbols-outlined text-[22px]">{playing ? 'pause' : 'play_arrow'}</span>
            </button>
            <button onClick={() => setIndex(i => Math.min(total - 1, i + 1))} className="text-on-surface-variant hover:text-on-surface w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-container-high transition-colors shrink-0" title="Step Forward">
              <span className="material-symbols-outlined text-[18px]">navigate_next</span>
            </button>
            <button onClick={() => { setIndex(total > 0 ? total - 1 : 0); setPlaying(false); }} className="text-on-surface-variant hover:text-on-surface w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-container-high transition-colors shrink-0" title="Skip to End">
              <span className="material-symbols-outlined text-[18px]">skip_next</span>
            </button>
            
            <div className="flex items-center gap-2 ml-1 text-code-sm font-code-sm text-on-surface-variant monospaced-digits shrink-0">
              <span className="shrink-0 text-[11px]">Step {total > 0 ? index + 1 : 0}/{total}</span>
              <div className="h-1 bg-surface-container-high w-14 sm:w-20 md:w-28 rounded-full overflow-hidden relative cursor-pointer hidden sm:block" onClick={(e) => {
                 if (total === 0) return;
                 const rect = e.currentTarget.getBoundingClientRect();
                 const clickX = e.clientX - rect.left;
                 const newPct = clickX / rect.width;
                 setIndex(Math.floor(newPct * (total - 1)));
                 setPlaying(false);
              }}>
                <div className="h-full bg-primary absolute top-0 left-0" style={{ width: `${progressPercent}%` }}></div>
              </div>
            </div>
          </div>
        )}
        
        {/* RIGHT: Speed + View Switcher + Reset + Run */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <a 
            href="https://github.com/abhinavkumar0811/Java-arch-visulization/issues/new?template=bug_report.yml" 
            target="_blank" 
            rel="noreferrer"
            className="hidden md:flex items-center gap-1 text-on-surface-variant hover:text-on-surface text-[11px] font-bold uppercase tracking-wider px-2 py-1 rounded hover:bg-surface-container transition-colors"
            title="Report a bug or suggest a feature on GitHub"
          >
            <span className="material-symbols-outlined text-[14px]">bug_report</span>
            Report Bug
          </a>
          {activeView !== 'dry-run' && (
            <div className="hidden lg:flex items-center gap-1.5 bg-surface-container px-2 py-1 rounded-lg border border-border-subtle shrink-0" title="Playback Speed">
              <span className="material-symbols-outlined text-[15px] text-on-surface-variant">speed</span>
              <input 
                type="range" 
                min="100" 
                max="2000" 
                step="100" 
                value={2100 - speed} 
                onChange={(e) => setSpeed(2100 - Number(e.target.value))}
                className="w-16 accent-primary cursor-pointer"
              />
              <span className="text-on-surface-variant text-[11px] font-bold w-5 text-right monospaced-digits">
                {speed === 1200 ? '1x' : (1200 / speed).toFixed(1).replace('.0', '') + 'x'}
              </span>
            </div>
          )}
          
          <div className="flex bg-surface-container rounded-lg p-0.5 border border-border-subtle shrink-0">
            <button 
              onClick={() => handleViewSwitch('memory')}
              className={`px-2.5 py-1 rounded text-label-caps font-label-caps transition-colors ${activeView === 'memory' ? 'bg-surface shadow text-primary font-bold' : 'text-on-surface-variant hover:text-on-surface'}`}
            >
              Memory
            </button>
            <button 
              onClick={() => handleViewSwitch('complexity')}
              className={`px-2.5 py-1 rounded text-label-caps font-label-caps transition-colors ${activeView === 'complexity' ? 'bg-surface shadow text-primary font-bold' : 'text-on-surface-variant hover:text-on-surface'}`}
            >
              Complexity
            </button>
            <button 
              onClick={() => { setActiveView('dry-run'); localStorage.setItem('activeView', 'dry-run'); }}
              className={`px-2.5 py-1 rounded text-label-caps font-label-caps transition-colors flex items-center gap-1 ${activeView === 'dry-run' ? 'bg-surface shadow text-primary font-bold' : 'text-on-surface-variant hover:text-on-surface'}`}
            >
              <span className="material-symbols-outlined text-[12px]">bug_report</span>
              Dry Run
            </button>
          </div>

          {activeView !== 'dry-run' && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => { setIndex(0); setPlaying(false); }} className="border border-border-subtle hover:border-outline text-on-surface px-2.5 py-1 rounded text-label-caps font-label-caps transition-colors shrink-0">
                Reset
              </button>
              <button onClick={runCode} disabled={loading} className="bg-primary text-on-primary hover:bg-primary-fixed transition-colors px-3.5 py-1 rounded text-label-caps font-label-caps font-bold shrink-0 shadow-xs">
                {loading ? 'Running...' : 'Run'}
              </button>
            </div>
          )}
        </div>
      </nav>

      <main className={`flex-1 flex gap-gutter overflow-hidden bg-surface-container-lowest ${activeView === 'dry-run' ? 'p-0' : 'p-gutter'}`}>
        {activeView === 'memory' ? (
          <>
            <section className={`flex flex-col gap-gutter h-full transition-all duration-300 ${isEditorExpanded ? 'w-full' : 'w-[40%]'}`}>
              <div className="bg-surface border border-border-subtle rounded-lg flex-1 flex flex-col overflow-hidden shadow-sm">
                <div className="bg-surface-container border-b border-border-subtle px-panel-padding py-2 flex items-center justify-between">
                  <div className="text-label-caps font-label-caps text-on-surface-variant uppercase tracking-wider flex gap-4">
                    <button onClick={() => setActiveTab('source')} className={activeTab === 'source' ? "text-on-surface border-b border-on-surface pb-1" : "opacity-50 hover:opacity-100 transition-opacity"}>Source Code (.java)</button>
                    <button onClick={() => setActiveTab('bytecode')} className={activeTab === 'bytecode' ? "text-on-surface border-b border-on-surface pb-1" : "opacity-50 hover:opacity-100 transition-opacity"}>Bytecode (.class)</button>
                  </div>
                  <div className="flex items-center gap-1 text-on-surface-variant">
                    <button onClick={() => setCode(EXAMPLES[exampleName])} className="hover:text-on-surface w-7 h-7 flex items-center justify-center rounded hover:bg-surface-container-high transition-colors" title="Reset Code">
                      <span className="material-symbols-outlined text-[18px] leading-none">refresh</span>
                    </button>
                    <button onClick={() => setIsEditorExpanded(e => !e)} className="hover:text-on-surface w-7 h-7 flex items-center justify-center rounded hover:bg-surface-container-high transition-colors" title={isEditorExpanded ? "Collapse" : "Expand Fullscreen"}>
                      <span className="material-symbols-outlined text-[18px] leading-none">{isEditorExpanded ? 'fullscreen_exit' : 'fullscreen'}</span>
                    </button>
                    <div className="w-[1px] h-4 bg-border-subtle mx-1"></div>
                    <span className="material-symbols-outlined text-[18px] leading-none ml-1" title="Code Editor">code</span>
                  </div>
                </div>
                
                {activeTab === 'source' ? (
                  <CodeEditor code={code} setCode={handleCodeChange} activeLine={activeLine} lineHits={metrics.lineHits} />
                ) : (
                  <BytecodeView bytecode={bytecode} />
                )}
              </div>
              
              {error && <ExecutionErrorNotice error={error} code={code} onDismiss={() => setError(null)} />}
              <TutorView prev={trace[index - 1]} curr={current} activeLine={activeLine} />
              <ConsoleView lines={current?.stdout || []} />
            </section>

            {!isEditorExpanded && (
              <>
                <section className="flex flex-col gap-gutter w-[30%] h-full">
                  <MethodAreaView methodArea={current?.methodArea || {}} onInfoClick={() => setInfoModal('METHOD_AREA')} />
                  <HeapView heap={current?.heap || {}} stringPool={current?.stringPool || {}} onInfoClick={() => setInfoModal('HEAP')} />
                  <PCRegisterView activeLine={activeLine} onInfoClick={() => setInfoModal('PC_REGISTER')} />
                </section>

                <section className="flex flex-col gap-gutter w-[30%] h-full">
                  <CallStackView currentThread={activeThread} onInfoClick={() => setInfoModal('CALL_STACK')} />
                  <ThreadsView threads={current?.threads || {}} activeThreadId={current?.threadId} onInfoClick={() => setInfoModal('THREADS')} />
                </section>
              </>
            )}
          </>
        ) : activeView === 'complexity' ? (
          <ComplexityView
            code={code}
            setCode={handleCodeChange}
            bigO={bigO}
            metrics={metrics}
            trace={trace}
            currentIndex={index}
            setCurrentIndex={setIndex}
            playing={playing}
            setPlaying={setPlaying}
          />
        ) : (
          <DryRunView initialCode={code} forceSyncCode={dryRunSyncCode} setForceSyncCode={setDryRunSyncCode} />
        )}
      </main>
      
      <InfoModal type={infoModal} onClose={() => setInfoModal(null)} />
      <AboutModal isOpen={isAboutModalOpen} onClose={() => setIsAboutModalOpen(false)} />
      <MobileNotice />

      {/* View Switch Prompt Modal */}


      {switchPrompt && switchPrompt.type === 'sync' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface border border-border-subtle rounded-xl shadow-2xl p-6 w-[400px] flex flex-col gap-4 animate-in fade-in zoom-in duration-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                <span className="material-symbols-outlined text-[20px]">content_copy</span>
              </div>
              <div>
                <h3 className="text-on-surface font-bold text-lg leading-tight">Sync Code?</h3>
                <p className="text-on-surface-variant text-body-sm mt-1">
                  You are switching to {switchPrompt.target === 'memory' ? 'Memory Management' : 'Complexity Analysis'}.
                </p>
              </div>
            </div>
            
            <p className="text-on-surface-variant text-[13px] leading-relaxed">
              The target view has different code. Do you want to bring your current code and trace into the new view, or start fresh?
            </p>

            <div className="flex justify-end gap-3 mt-2">
              <button 
                onClick={() => setSwitchPrompt(null)}
                className="px-4 py-2 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors text-label-caps font-bold mr-auto"
              >
                Cancel
              </button>
              <button 
                onClick={() => confirmSwitch('fresh')}
                className="px-4 py-2 rounded-lg border border-border-subtle text-on-surface hover:bg-surface-container transition-colors text-label-caps font-bold"
              >
                Start Fresh
              </button>
              <button 
                onClick={() => confirmSwitch('sync')}
                className="px-4 py-2 rounded-lg bg-primary text-on-primary hover:bg-primary-fixed transition-colors text-label-caps font-bold"
              >
                Copy Code Over
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
