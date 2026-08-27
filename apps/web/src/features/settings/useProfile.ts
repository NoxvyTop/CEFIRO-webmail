import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/useAuth";
import { fetchProfile } from "./api";

// Shared across the header (UserMenu, via App.tsx) and the Settings "Perfil"
// section so both read the same react-query cache entry — a photo/name save
// in ProfileSettings invalidates this key and the header avatar refetches.
export const PROFILE_QUERY_KEY = ["profile"] as const;

// The profile payload includes the ~1 MiB base64 avatar data: URL — cheap to
// keep around, expensive to redownload. A long staleTime stops it refetching
// on every mount, and disabling refetchOnWindowFocus stops it refetching
// every time the tab regains focus.
const PROFILE_STALE_TIME_MS = 5 * 60 * 1000;

export function useProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: fetchProfile,
    // Gate on the authenticated user (mirrors useAuth's own null-on-401
    // convention for *knowing* auth state) instead of letting fetchProfile's
    // throw-on-401 + react-query's default retries run their course — that
    // combination fires 4 doomed requests on the login screen before login.
    enabled: !!user,
    staleTime: PROFILE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}
