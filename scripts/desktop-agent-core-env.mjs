/**
 * Environment for Playwright-launched Kestrel.
 *
 * Agent Core always runs under a real Node child. Non-packaged launches must
 * pass KESTREL_NODE_EXEC_PATH; packaged apps ignore it and use the sidecar.
 * Calling scripts run under Node/tsx, so process.execPath is a valid Node.
 */
export function withDesktopAgentCoreEnv(env = process.env) {
	return {
		...env,
		KESTREL_NODE_EXEC_PATH: env.KESTREL_NODE_EXEC_PATH || process.execPath,
	};
}
