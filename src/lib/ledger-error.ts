/** A user-facing validation/ledger error. `status` is the HTTP status to answer with. */
export class LedgerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
