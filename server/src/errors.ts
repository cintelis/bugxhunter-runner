/** An Error that sendError() turns into an HTTP status. */
export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
