// The shape of a failed use case: an HTTP-ish status plus the standard error list.
export const fail = (status, code, message) => ({ ok: false, status, errors: [{ code, field: 'request', message }] });
