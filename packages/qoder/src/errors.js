// Qoder: the error the sign-in code tells apart. A sign-in that can't sign a request; only Qoder refusing the refresh
// token marks the account lapsed (expired).
export class SignInGone extends Error {
  constructor(message, expired = false) {
    super(message);
    this.gone = true;
    this.expired = expired;
  }
}
