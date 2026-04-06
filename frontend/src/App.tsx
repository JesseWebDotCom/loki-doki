import { useState } from 'react'
import { MessageSquare, FlaskConical, Settings, Ghost } from 'lucide-react'
import TestRunner from './components/Tests/TestRunner'

function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'tests' | 'settings'>('chat')

  const tabs = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare size={20} /> },
    { id: 'tests', label: 'Tests', icon: <FlaskConical size={20} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={20} /> },
  ]

  return (
    <div className="flex h-screen w-screen bg-[#0f1012] overflow-hidden font-sans">
      {/* Sidebar Navigation */}
      <aside className="w-16 flex flex-col items-center py-8 border-r border-gray-800/50 bg-[#0c0d0e]">
        <div className="mb-12">
          <Ghost className="text-blue-500 w-8 h-8" strokeWidth={2.5} />
        </div>
        <nav className="flex flex-col gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`p-3 rounded-xl transition-all duration-200 group relative ${
                activeTab === tab.id 
                  ? 'bg-blue-600/10 text-blue-500' 
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.icon}
              <span className="absolute left-full ml-4 px-2 py-1 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none uppercase tracking-widest">
                {tab.label}
              </span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {activeTab === 'tests' ? (
          <TestRunner />
        ) : (
          <div className="p-8 flex-1 flex flex-col items-center justify-center text-center">
            <Ghost className="text-gray-800 w-24 h-24 mb-6 opacity-20" />
            <h2 className="text-2xl font-bold text-gray-400">
              {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Mode
            </h2>
            <p className="text-gray-600 mt-2 max-w-md">
              Switching to another tab for autonomous development. 
              The TDD workflow is currently active in the <span className="text-blue-400">Tests</span> tab.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
