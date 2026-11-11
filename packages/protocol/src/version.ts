/**
 * Protocol version constant — M1-01 (contracts C-PROTOCOL-01/C-DB-01).
 *
 * Every wire envelope carries `schemaVersion`. Bump only with an
 * architect-approved contract amendment; receivers must reject unknown
 * versions rather than best-effort parse.
 *
 * Evidence: [DESIGN] (spec §5).
 */
export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
