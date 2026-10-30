/** The types of `statusline-line.mjs`: the line this module prints in a session when the person has no status line of their own. */

export declare const NEAR: number
export declare const AT: number
export declare const MARGIN: number
export declare const WIDE: number

export interface Part {
  full: string
  short: string
  colour?: string
}

export declare function resetSaid(resets: number, now: number): string
export declare function parts(json: unknown, now: number): Part[]
export declare function compose(json: unknown, options?: { columns?: number | null; now?: number; colour?: boolean }): string
