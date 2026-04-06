import React, { useState, useEffect } from 'react';
import { Brain, Search, Users, User, Database, Clock, Trash2, X } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import { getFacts, searchFacts, getSessions, deleteSession } from '../lib/api';
import type { Fact } from '../lib/api';

const MemoryPage: React.FC = () => {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [sessions, setSessions] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ fact: string; score: number }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<'identity' | 'relationships' | 'all' | 'context'>('all');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [factsRes, sessionsRes] = await Promise.all([getFacts(), getSessions()]);
      setFacts(factsRes.facts);
      setSessions(sessionsRes.sessions);
    } catch {
      // API not available
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await searchFacts(searchQuery);
      setSearchResults(res.results);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    await deleteSession(sessionId);
    setSessions(prev => prev.filter(s => s !== sessionId));
  };

  const identityFacts = facts.filter(f => f.category === 'identity' || f.category === 'user');
  const relationshipFacts = facts.filter(f => f.category === 'family' || f.category === 'relationship' || f.category === 'friend');
  const filteredFacts = activeTab === 'identity' ? identityFacts
    : activeTab === 'relationships' ? relationshipFacts
    : facts;

  const tabs = [
    { id: 'all' as const, label: 'All Facts', icon: <Database size={14} />, count: facts.length },
    { id: 'identity' as const, label: 'Identity', icon: <User size={14} />, count: identityFacts.length },
    { id: 'relationships' as const, label: 'Relationships', icon: <Users size={14} />, count: relationshipFacts.length },
    { id: 'context' as const, label: 'Sessions', icon: <Clock size={14} />, count: sessions.length },
  ];

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />

      <main className="flex-1 flex flex-col relative bg-background shadow-inner overflow-y-auto">
        <header className="p-10 border-b border-border/10">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-m2">
              <Brain size={28} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Memory Index</h1>
              <p className="text-muted-foreground text-sm font-medium">
                {facts.length} facts stored • {sessions.length} sessions recorded
              </p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Search Bar */}
            <div className="relative group">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search memory with BM25 keyword matching..."
                className="w-full bg-card/50 border border-border/50 rounded-xl py-3 pl-12 pr-24 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all text-sm font-medium"
              />
              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-primary/10 text-primary text-xs font-bold rounded-lg border border-primary/20 hover:bg-primary/20 transition-all"
              >
                {isSearching ? 'Searching...' : 'Search'}
              </button>
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                    Search Results ({searchResults.length})
                  </h3>
                  <button
                    onClick={() => { setSearchResults([]); setSearchQuery(''); }}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <X size={12} /> Clear
                  </button>
                </div>
                {searchResults.map((result, i) => (
                  <div key={i} className="p-4 rounded-xl bg-primary/5 border border-primary/10">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{result.fact}</span>
                      <span className="text-[10px] font-mono text-primary font-bold">
                        score: {result.score.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-2 border-b border-border/10 pb-2">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                    activeTab === tab.id
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:bg-card/50 border border-transparent'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                  <span className="text-[10px] font-mono opacity-60">({tab.count})</span>
                </button>
              ))}
            </div>

            {/* Fact List / Session List */}
            {activeTab !== 'context' ? (
              <div className="space-y-3">
                {filteredFacts.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground text-sm italic">
                    No facts stored yet. Start chatting to build memory.
                  </div>
                ) : (
                  filteredFacts.map((fact, i) => (
                    <div key={i} className="p-4 rounded-xl bg-card/50 border border-border/30 hover:border-border/60 transition-all">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <span className="text-sm font-medium leading-relaxed">{fact.fact}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20">
                            {fact.category}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {fact.created_at?.split('T')[0] || ''}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {sessions.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground text-sm italic">
                    No sessions recorded yet.
                  </div>
                ) : (
                  sessions.map((sessionId) => (
                    <div key={sessionId} className="p-4 rounded-xl bg-card/50 border border-border/30 hover:border-border/60 transition-all flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Clock size={14} className="text-muted-foreground" />
                        <span className="text-sm font-mono font-medium">{sessionId}</span>
                      </div>
                      <button
                        onClick={() => handleDeleteSession(sessionId)}
                        className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                        title="Delete session"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default MemoryPage;
