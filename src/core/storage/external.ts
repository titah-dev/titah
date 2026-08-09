import { database } from "./db.ts"

/**
 * Pemetaan sesi Titah → sesi agent eksternal (Q12).
 *
 * Tanpa ini, setiap `@claude` memulai percakapan baru dan user harus mengulang
 * seluruh konteks — persis keluhan yang membuat delegasi terasa tidak berguna.
 */

export function rememberExternalSession(
  sessionID: string,
  agentID: string,
  externalID: string,
): void {
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO external_session (session_id, agent_id, external_id, created, updated)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, agent_id)
       DO UPDATE SET external_id = excluded.external_id, updated = excluded.updated`,
    )
    .run(sessionID, agentID, externalID, now, now)
}

export function externalSessionFor(sessionID: string, agentID: string): string | undefined {
  const row = database()
    .prepare("SELECT external_id FROM external_session WHERE session_id = ? AND agent_id = ?")
    .get(sessionID, agentID) as { external_id: string } | undefined
  return row?.external_id
}

export function listExternalSessions(
  sessionID: string,
): { agentID: string; externalID: string; updated: number }[] {
  const rows = database()
    .prepare(
      "SELECT agent_id, external_id, updated FROM external_session WHERE session_id = ? ORDER BY updated DESC",
    )
    .all(sessionID) as unknown as { agent_id: string; external_id: string; updated: number }[]
  return rows.map((row) => ({
    agentID: row.agent_id,
    externalID: row.external_id,
    updated: row.updated,
  }))
}

export function forgetExternalSession(sessionID: string, agentID: string): boolean {
  return (
    database()
      .prepare("DELETE FROM external_session WHERE session_id = ? AND agent_id = ?")
      .run(sessionID, agentID).changes > 0
  )
}
