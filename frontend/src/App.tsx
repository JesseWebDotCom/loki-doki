import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './components/theme/ThemeProvider';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';
import MemoryPage from './pages/MemoryPage';
import WizardPage from './pages/WizardPage';
import LoginPage from './pages/LoginPage';
import AdminPage from './pages/AdminPage';
import { AuthProvider } from './auth/AuthProvider';
import { BootstrapGate } from './components/BootstrapGate';

const App: React.FC = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="lokidoki-theme">
      <Router>
        <AuthProvider>
          <BootstrapGate>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/wizard" element={<WizardPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </BootstrapGate>
        </AuthProvider>
      </Router>
    </ThemeProvider>
  );
};

export default App;
