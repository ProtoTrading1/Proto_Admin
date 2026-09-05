import { createClient } from '@supabase/supabase-js';

// Keep admin authentication separate from Apollo's isolated data client.
// The fallback preserves the existing production configuration.
const authUrl = import.meta.env.VITE_ADMIN_AUTH_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL;
const authKey = import.meta.env.VITE_ADMIN_AUTH_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseAuth = createClient(authUrl, authKey);
