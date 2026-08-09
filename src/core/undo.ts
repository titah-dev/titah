import type { Message } from "./message.ts"
import { restore } from "./snapshot.ts"
import { getSession, listMessages } from "./storage/session.ts"

export class UndoError extends Error {}

export interface UndoResult {
  messageID: string
  snapshot: string
  files: string[]
}

/** Giliran terakhir yang benar-benar mengubah sesuatu. */
export function lastMutatingMessage(sessionID: string): Message | undefined {
  return listMessages(sessionID)
    .filter((message) => message.role === "assistant" && message.snapshot !== undefined)
    .at(-1)
}

/**
 * Mengembalikan direktori kerja ke keadaan sebelum giliran terakhir menulis.
 *
 * Snapshot diambil sekali per giliran, sebelum perubahan pertama — jadi satu
 * `/undo` membatalkan seluruh giliran, bukan satu tool saja. Itu yang diharapkan
 * user: "batalkan yang barusan kamu lakukan".
 */
export async function undo(sessionID: string): Promise<UndoResult> {
  const session = getSession(sessionID)
  if (!session) throw new UndoError(`Session not found: ${sessionID}`)

  const message = lastMutatingMessage(sessionID)
  if (!message?.snapshot) {
    throw new UndoError("There is nothing to undo in this session.")
  }

  const { files } = await restore(session.directory, message.snapshot)
  return { messageID: message.id, snapshot: message.snapshot, files }
}
