// Covers src/b.js through a path alias. Only the last segment of the
// specifier is compared, so whatever the resolver maps @ to does not matter.
import { app } from '@/b';
export { app };
