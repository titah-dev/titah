import { matchesPattern } from "./match.ts"

/**
 * SATU fungsi penilai izin, untuk tiga dimensi.
 *
 * # Kenapa satu fungsi
 *
 * Bug allowlist (#12) terjadi karena logika pencocokan hidup TERPISAH dari apa
 * yang ia klaim cocokkan, dan gejalanya diam: pola yang tidak pernah menyala,
 * dan pola yang menyala terlalu lebar. Tiga dimensi berarti tiga kesempatan
 * mengulang kesalahan itu.
 *
 * Karena itu seluruh keputusan hidup di `decide()` di bawah, dan setiap
 * pemanggil — `ask()`, `titah permission explain`, dan test — memanggil fungsi
 * yang SAMA. Yang dijelaskan `explain` tidak bisa berbeda dari yang dijalankan.
 *
 * # Tiga dimensi, dan pertanyaannya masing-masing
 *
 *   KELAS    — jenis kerusakan apa?            `bash: "ask"`
 *   ARGUMEN  — panggilan yang seperti apa?     `bash(git *): "allow"`
 *   SITUASI  — apa yang terjadi di sekitarnya? deteksi perulangan
 *
 * Ketiganya ortogonal, jadi mereka tidak bersaing — mereka berurutan.
 *
 * # Aturan penggabungan, dan dua keputusan yang membentuknya
 *
 * 1. **`deny` adalah tembok, di tingkat mana pun.** Satu `deny` yang cocok
 *    menghentikan segalanya, dan tidak ada aturan yang lebih spesifik yang bisa
 *    membukanya. Tanpa aturan ini, kalimat "tidak ada apa pun yang keluar dari
 *    mesin ini" berhenti jadi jaminan begitu ada satu pola `allow` di suatu
 *    tempat — dan jaminan itulah satu-satunya alasan dimensi kelas bernilai.
 *
 * 2. **Di antara `ask` dan `allow`, yang paling SPESIFIK menang.** Tanpa ini,
 *    dimensi argumen tidak berguna: `bash: "ask"` + `bash(git *): "allow"`
 *    tidak akan pernah bisa berarti "tanya untuk bash, kecuali git".
 *
 * Situasi hanya boleh MENGETATKAN — ia mengubah `allow` jadi `ask`, tidak
 * pernah sebaliknya. Deteksi perulangan tidak pernah mengizinkan apa pun; ia
 * hanya menyela sesuatu yang sudah diizinkan.
 */

export type Policy = "ask" | "allow" | "deny"

export interface Rule {
  /** Sumbu yang dibatasi, mis. `bash`. */
  kind: string
  /** Pola argumen, atau `undefined` untuk aturan setingkat kelas. */
  pattern: string | undefined
  policy: Policy
  /** Bentuk aslinya, untuk dilaporkan apa adanya kepada user. */
  source: string
}

/**
 * `"bash(git *)"` → `{ kind: "bash", pattern: "git *" }`.
 *
 * Bentuk tanpa kurung (`"bash"`) sah dan berarti setingkat kelas — itu membuat
 * `permission.rules` bisa menyatakan hal yang sama dengan blok `permission`,
 * dan keduanya dinilai lewat jalur yang sama alih-alih dua jalur yang bisa
 * menyimpang.
 */
export function parseRule(source: string, policy: Policy): Rule {
  const open = source.indexOf("(")
  if (open === -1 || !source.endsWith(")")) {
    return { kind: source.trim(), pattern: undefined, policy, source }
  }
  return {
    kind: source.slice(0, open).trim(),
    pattern: source.slice(open + 1, -1),
    policy,
    source,
  }
}

/**
 * Seberapa spesifik sebuah aturan, untuk memilih pemenang di antara `ask` dan
 * `allow`.
 *
 * Dihitung dari jumlah karakter yang BUKAN wildcard. `git push *` (10) menang
 * atas `git *` (4), yang menang atas aturan setingkat kelas (0).
 *
 * Sengaja bukan "yang ditulis belakangan menang": urutan di berkas config
 * adalah hal yang paling mudah berubah tanpa disengaja — menambah satu baris di
 * tempat yang salah tidak boleh diam-diam mengubah arti aturan lain.
 */
export function specificity(rule: Rule): number {
  if (rule.pattern === undefined) return 0
  return rule.pattern.replaceAll("*", "").length
}

export interface Candidate {
  /** Argumen yang dinilai. Untuk bash, SATU segmen perintah. */
  value: string
}

export interface Decision {
  policy: Policy
  /** Aturan yang menentukan, atau `undefined` kalau kebijakan kelas yang menang. */
  rule: Rule | undefined
  /** Kalimat untuk user dan untuk `explain`. */
  reason: string
  /** Aturan yang ikut cocok tapi kalah — hanya untuk `explain`. */
  alsoMatched: Rule[]
}

export interface DecideInput {
  kind: string
  /** Kebijakan kelas untuk sumbu ini. */
  classPolicy: Policy
  rules: Rule[]
  /**
   * Bagian yang dinilai per argumen.
   *
   * Untuk `bash` ini SETIAP SEGMEN perintah, dan semuanya harus lolos — aturan
   * dari issue #12, dipertahankan di sini alih-alih ditulis ulang di pemanggil.
   * Untuk sumbu tanpa argumen, kosong.
   */
  candidates: Candidate[]
}

function matching(rules: Rule[], kind: string, value: string | undefined): Rule[] {
  return rules.filter((rule) => {
    if (rule.kind !== kind) return false
    if (rule.pattern === undefined) return true
    if (value === undefined) return false
    return matchesPattern(rule.pattern, value)
  })
}

/**
 * Keputusan untuk satu permintaan izin.
 *
 * Untuk `bash`, `candidates` memuat setiap segmen perintah dan SEMUANYA harus
 * lolos: satu segmen yang jatuh ke `ask` membuat seluruh perintah ditanyakan,
 * dan satu segmen yang `deny` menolak seluruhnya. Itu aturan yang sama dengan
 * #12, sekarang berlaku untuk `deny` juga.
 */
export function decide(input: DecideInput): Decision {
  const classRule: Rule | undefined = undefined
  const perCandidate: Decision[] = []

  const evaluate = (value: string | undefined): Decision => {
    const matched = matching(input.rules, input.kind, value)

    // 1. `deny` setingkat ATURAN menang mutlak, tanpa memandang spesifisitas.
    //    Ini tembok yang sesungguhnya, dan satu-satunya yang tidak bisa dibuka.
    const denied = matched.find((rule) => rule.policy === "deny")
    if (denied) {
      return {
        policy: "deny",
        rule: denied,
        reason: `Denied by rule "${denied.source}".`,
        alsoMatched: matched.filter((rule) => rule !== denied),
      }
    }

    /*
     * 2. `deny` setingkat KELAS adalah DEFAULT deny — ia bisa dipersempit
     *    aturan `allow` yang eksplisit.
     *
     * Versi pertama memperlakukannya sebagai tembok juga, dan itu keliru karena
     * dua alasan yang saling menguatkan.
     *
     * Pertama, ia membuat bentuk yang paling berguna tidak bisa diungkapkan:
     * "tolak semuanya KECUALI ini" adalah pola daftar-putih yang dipakai setiap
     * firewall dan setiap sistem IAM, dan tanpa ini satu-satunya cara
     * mendekatinya adalah `ask` — yang berarti user diganggu untuk hal yang
     * sudah ia putuskan.
     *
     * Kedua, dan lebih parah: ia membuat aturan `allow` di bawah kelas yang
     * `deny` menjadi MATI TANPA SUARA. Itu persis kelas kegagalan #12 — pola
     * yang ditulis user, terlihat berlaku, dan tidak pernah menyala.
     *
     * Tembok mutlak tetap bisa dinyatakan, dan bentuknya jadi eksplisit:
     * `"network(*)": "deny"` menolak segalanya dan tidak bisa dibuka apa pun.
     */
    if (input.classPolicy === "deny" && !matched.some((rule) => rule.policy === "allow")) {
      return {
        policy: "deny",
        rule: classRule,
        reason:
          `Denied by ${input.kind} = "deny", and no rule allows it.` +
          (matched.length > 0 ? " (matching rules do not allow)" : ""),
        alsoMatched: matched,
      }
    }

    // 2. Di antara `ask` dan `allow`, yang paling spesifik menang. Seri
    //    dimenangkan `ask`: dua aturan yang sama spesifiknya dan bertentangan
    //    adalah config yang ambigu, dan menebak ke arah longgar pada config
    //    yang ambigu adalah cara membuat izin yang tidak pernah user maksud.
    const ranked = [...matched].sort((a, b) => {
      const gap = specificity(b) - specificity(a)
      if (gap !== 0) return gap
      return a.policy === "ask" ? -1 : b.policy === "ask" ? 1 : 0
    })
    const winner = ranked[0]
    if (winner) {
      return {
        policy: winner.policy,
        rule: winner,
        reason: `${winner.policy === "allow" ? "Allowed" : "Asked"} by rule "${winner.source}".`,
        alsoMatched: ranked.slice(1),
      }
    }

    // 3. Tidak ada aturan yang cocok: kebijakan kelas yang berlaku.
    return {
      policy: input.classPolicy,
      rule: classRule,
      reason: `${input.kind} = "${input.classPolicy}", and no rule matched.`,
      alsoMatched: [],
    }
  }

  if (input.candidates.length === 0) return evaluate(undefined)
  for (const candidate of input.candidates) perCandidate.push(evaluate(candidate.value))

  // Yang paling ketat di antara segmen yang menang. `deny` mengalahkan `ask`,
  // `ask` mengalahkan `allow`.
  const order: Policy[] = ["deny", "ask", "allow"]
  for (const policy of order) {
    const found = perCandidate.find((decision) => decision.policy === policy)
    if (found) {
      return input.candidates.length > 1 && policy !== "allow"
        ? { ...found, reason: `${found.reason} (one part of the command decides the whole)` }
        : found
    }
  }
  return evaluate(undefined)
}
