export type Factory<Args extends unknown[], Value> = (...args: Args) => Value;

/** Decorate the factory selected at the time this function is called. */
export function decorateCurrentFactory<Args extends unknown[], Value>(
	current: Factory<Args, Value> | undefined,
	fallback: Factory<Args, Value>,
	decorate: (value: Value) => Value,
): Factory<Args, Value> {
	const base = current ?? fallback;
	return (...args: Args) => decorate(base(...args));
}
