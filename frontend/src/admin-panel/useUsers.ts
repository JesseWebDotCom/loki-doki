import { useState, useCallback, useEffect } from 'react';

export type AdminUser = { 
  id: number; 
  username: string; 
  role: 'admin' | 'user'; 
  status: 'active' | 'disabled' | 'deleted' 
};

export const useUsers = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/admin/users', { credentials: 'include' });
      if (!r.ok) { 
        setError(`load failed (${r.status})`); 
        return; 
      }
      const data = (await r.json()) as { users: AdminUser[] };
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError('Network error');
    }
  }, []);

  useEffect(() => { 
    void refresh(); 
  }, [refresh]);

  return { users, error, refresh };
};
