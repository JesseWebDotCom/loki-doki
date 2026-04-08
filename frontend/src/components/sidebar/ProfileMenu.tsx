import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings, ShieldCheck, Wrench, LogOut, ChevronUp, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { useAuth } from '../../auth/useAuth';

interface ProfileMenuProps {
  /** Render only the avatar button (for collapsed sidebar rail). */
  compact?: boolean;
}

const ProfileMenu: React.FC<ProfileMenuProps> = ({ compact = false }) => {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  const username = currentUser?.username ?? 'Guest';
  const role = currentUser?.role ?? 'user';
  const initial = username.charAt(0).toUpperCase();
  const isAdmin = role === 'admin';

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold text-sm shadow-m1 hover:scale-105 transition-transform focus:outline-none"
            aria-label="Open profile menu"
            title={username}
          >
            {currentUser ? initial : <User size={16} />}
          </button>
        ) : (
        <button
          className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg border border-transparent hover:bg-card/50 hover:border-sidebar-border/50 transition-all duration-300 group focus:outline-none focus:bg-card/50 focus:border-sidebar-border/50"
          aria-label="Open profile menu"
        >
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold text-sm shadow-m1 group-hover:scale-105 transition-transform">
            {currentUser ? initial : <User size={16} />}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm font-bold text-sidebar-foreground truncate">{username}</div>
            <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
              {role}
            </div>
          </div>
          <ChevronUp size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings size={16} />
          <span>Settings</span>
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem onSelect={() => navigate('/admin')}>
            <ShieldCheck size={16} />
            <span>Admin Panel</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => navigate('/dev')}>
          <Wrench size={16} />
          <span>Dev Tools</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleLogout} className="focus:bg-destructive/10 focus:text-destructive">
          <LogOut size={16} />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ProfileMenu;
