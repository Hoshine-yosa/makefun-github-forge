// Local test server: runs the forge on a fixed port without the env lifecycle.
import { createApp } from './app.ts';
const port = Number(process.env.PORT ?? 18099);
const server = createApp();
server.listen(port, () => { process.stdout.write(`[local] listening on ${port}\n`); });
