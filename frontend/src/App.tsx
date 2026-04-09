import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './components/theme/ThemeProvider';
import ChatPage from './pages/ChatPage';
import MemoryPage from './pages/MemoryPage';
import PeoplePage from './pages/PeoplePage';
import WizardPage from './pages/WizardPage';
import LoginPage from './pages/LoginPage';
import { SettingsPage, AdminPage, DevToolsPage } from './admin-panel/AdminPanelPage';
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
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/people" element={<PeoplePage />} />
              <Route path="/wizard" element={<WizardPage />} />
              <Route path="/login" element={<LoginPage />} />

              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/:section" element={<SettingsPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/admin/:section" element={<AdminPage />} />
              <Route path="/dev" element={<DevToolsPage />} />
              <Route path="/dev/:section" element={<DevToolsPage />} />

              {/* Legacy redirect from earlier merged layout */}
              <Route path="/admin-panel" element={<Navigate to="/settings" replace />} />
              <Route path="/admin-panel/:section" element={<Navigate to="/settings" replace />} />
            </Routes>
          </BootstrapGate>
        </AuthProvider>
      </Router>
    </ThemeProvider>
  );
};

export default App;
