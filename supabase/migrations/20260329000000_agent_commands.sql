-- Agent commands: interactive request/response between web UI and agent.
-- Separate from pipeline_jobs (which are long-running queued work).

CREATE TABLE public.agent_commands (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agent_id      UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    command_type  TEXT NOT NULL,
    payload       JSONB NOT NULL DEFAULT '{}',
    result        JSONB,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);

-- Agent poll: find pending commands for this agent
CREATE INDEX idx_agent_commands_agent_pending
    ON public.agent_commands (agent_id, status)
    WHERE status = 'pending';

-- User lookup: list commands for a user (most recent first)
CREATE INDEX idx_agent_commands_user_created
    ON public.agent_commands (user_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.agent_commands ENABLE ROW LEVEL SECURITY;

-- Users can manage their own commands
CREATE POLICY agent_commands_user_all ON public.agent_commands
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Agent machine users can read/update commands targeted at them
-- (agent machine user's uid maps to agent owner via agents table)
CREATE POLICY agent_commands_agent_access ON public.agent_commands
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.id = agent_commands.agent_id
              AND a.supabase_uid = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.id = agent_commands.agent_id
              AND a.supabase_uid = auth.uid()
        )
    );

-- Service role bypass
CREATE POLICY agent_commands_service ON public.agent_commands
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ── Realtime ─────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_commands;
