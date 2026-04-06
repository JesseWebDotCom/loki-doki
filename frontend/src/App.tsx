import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './components/theme/ThemeProvider';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';
import MemoryPage from './pages/MemoryPage';

const App: React.FC = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="lokidoki-theme">
      <Router>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
};

export default App;
