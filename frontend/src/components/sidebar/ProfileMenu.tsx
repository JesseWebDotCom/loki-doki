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
  const profileImage = currentUser?.profile_image_url;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="flex h-10 w-10 items-center justify-center rounded-xl text-primary transition-colors hover:bg-card/50 focus:outline-none cursor-pointer"
            aria-label="Open profile menu"
            title={username}
          >
            {profileImage ? (
              <img src={profileImage} alt={username} className="h-7 w-7 rounded-xl border border-primary/20 object-cover" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-xs font-bold">
                {currentUser ? initial : <User size={10} />}
              </span>
            )}
          </button>
        ) : (
        <button
          className="group flex w-full items-center rounded-xl px-1.5 py-2 transition-colors hover:bg-card/50 focus:outline-none cursor-pointer"
          aria-label="Open profile menu"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center text-primary">
            {profileImage ? (
              <img src={profileImage} alt={username} className="h-8 w-8 rounded-xl border border-primary/20 object-cover" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-sm font-bold">
                {currentUser ? initial : <User size={10} />}
              </span>
            )}
          </span>
          <span className="ml-1.5 min-w-0 flex-1 truncate text-left text-base font-medium text-sidebar-foreground">
            {username}
          </span>
          <ChevronUp size={15} className="mr-2 text-muted-foreground transition-colors group-hover:text-foreground" />
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
        {isAdmin && (
          <DropdownMenuItem onSelect={() => navigate('/dev')}>
            <Wrench size={16} />
            <span>Dev Tools</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/people')}>
          <User size={16} />
          <span>People</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleLogout} className="focus:bg-destructive/10 focus:text-destructive">
          <LogOut size={16} />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ProfileMenu;
