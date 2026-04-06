import React, { useState } from 'react';
import { Play, CheckCircle2, XCircle, Loader2, ListTree, Terminal } from 'lucide-react';
import axios from 'axios';

interface TestResult {
  status: 'idle' | 'passed' | 'failed' | 'running';
  output: string;
  summary: {
    exit_code?: number;
    details?: string;
  };
  timestamp: string | null;
}

const TestRunner: React.FC = () => {
  const [result, setResult] = useState<TestResult>({
    status: 'idle',
    output: '',
    summary: {},
    timestamp: null,
  });
  const [loading, setLoading] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const runTests = async (target: string = 'tests') => {
    setLoading(true);
    setResult(prev => ({ ...prev, status: 'running' }));
    try {
      const response = await axios.post('http://localhost:8000/api/v1/tests/run', { target });
      setResult(response.data);
    } catch (error) {
      setResult(prev => ({ 
        ...prev, 
        status: 'failed', 
        output: 'Error connecting to backend test runner.' 
      }));
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = () => {
    switch (result.status) {
      case 'passed': return <CheckCircle2 className="text-green-500 w-6 h-6" />;
      case 'failed': return <XCircle className="text-red-500 w-6 h-6" />;
      case 'running': return <Loader2 className="text-blue-500 w-6 h-6 animate-spin" />;
      default: return <Play className="text-gray-400 w-6 h-6" />;
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0f1012] text-gray-200 p-6 space-y-6">
      <header className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Terminal className="text-blue-400" />
            LokiDoki Test Runner
          </h1>
          <p className="text-sm text-gray-400 mt-1">Autonomous Quality Verification Engine</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => runTests('tests/unit')}
            disabled={loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-md transition-all font-medium shadow-lg shadow-blue-900/20"
          >
            Run Fast (Unit)
          </button>
          <button 
            onClick={() => runTests('tests')}
            disabled={loading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-md transition-all font-medium shadow-lg shadow-indigo-900/20"
          >
            Run Full Suite
          </button>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-6 overflow-hidden">
        {/* Summary Panel */}
        <section className="bg-[#1a1b1e] border border-gray-800 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
            <ListTree size={16} /> Status Summary
          </h2>
          <div className="flex items-center gap-4 p-4 bg-black/20 rounded-lg border border-gray-800">
            {getStatusIcon()}
            <div>
              <div className="text-lg font-bold capitalize">{result.status || 'Idle'}</div>
              <div className="text-xs text-gray-500">{result.timestamp || 'No tests run yet'}</div>
            </div>
          </div>
          {result.summary.details && (
            <div className="p-4 bg-black/40 rounded-lg text-sm font-mono text-blue-300 whitespace-pre-wrap leading-relaxed">
              {result.summary.details}
            </div>
          )}
        </section>

        {/* Output Panel */}
        <section className="md:col-span-2 bg-[#1a1b1e] border border-gray-800 rounded-xl flex flex-col overflow-hidden">
          <header className="p-4 border-b border-gray-800 flex justify-between items-center shrink-0">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
              <Terminal size={16} /> Console Output
            </h2>
            <button 
              onClick={() => setShowDetail(!showDetail)}
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              {showDetail ? 'Hide Full Logs' : 'View Detailed Logs'}
            </button>
          </header>
          <div className="flex-1 p-4 font-mono text-sm overflow-auto custom-scrollbar">
            {result.output ? (
              <pre className={`whitespace-pre-wrap ${showDetail ? '' : 'line-clamp-[20]'}`}>
                {result.output}
              </pre>
            ) : (
              <div className="h-full flex items-center justify-center text-gray-600 italic">
                Waiting for execution...
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="text-[10px] text-center text-gray-600 uppercase tracking-[0.2em] font-medium border-t border-gray-800/30 pt-4">
        LokiDoki Core • Agentic TDD Framework • {new Date().getFullYear()}
      </footer>
    </div>
  );
};

export default TestRunner;
