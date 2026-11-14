import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client.ts';

export function useSignOut(): { signOut: () => Promise<void>; failed: boolean } {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setFailed(false);
    try {
      await api.signOut();
    } catch {
      setFailed(true);
      return;
    }
    queryClient.clear();
    await navigate({ to: '/sign-in' });
  }

  return { signOut, failed };
}
