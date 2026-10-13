// Qoder: the two errors the sign-in and usage code tell apart.

// SignInGone is a sign-in that can't sign a request: a 401. Only Qoder
// refusing the refresh token marks the account lapsed (expired), as the
// built-in's qoderRefreshFailed did; no refresh token, or no account,
// answered 401 there without marking one.
export class SignInGone extends Error {
  constructor(message, expired = false) {
    super(message)
    this.expired = expired
  }
}

/** A usage read Qoder answered with a status other than 200. */
export class UsageStatus extends Error {
  constructor(status) {
    super(`qoder usage: upstream HTTP ${status}`)
    this.status = status
  }
}

/** The error a hook throws to have magpie mark the account's sign-in lapsed. */
export const expiredError = (e) => Object.assign(new Error(e.message), { signIn: "expired" })
