import { createClient } from '@supabase/supabase-js'

/*
CLIENT-SIDE INSTANCE
Used in:
- frontend pages
- dashboard realtime subscription
- auth session handling

Uses ANON KEY (safe to expose)
*/

export const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)



/*
SERVER-SIDE INSTANCE (ADMIN)
Used in:
- API routes
- bot backend
- settlement calculations
- link validation

Uses SERVICE ROLE KEY (NEVER expose to frontend)
Bypasses RLS
*/

export const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)