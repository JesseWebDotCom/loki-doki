import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './components/theme/ThemeProvider';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';
import ThemeCustomizer from './components/theme/ThemeCustomizer';

const App: React.FC = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="lokidoki-theme">
      <Router>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
        <ThemeCustomizer />
      </Router>
    </ThemeProvider>
  );
};

export default App;
