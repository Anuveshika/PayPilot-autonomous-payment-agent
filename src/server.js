import { createAppContext } from "./app-context.js";
import { createHttpApp } from "./api/http-app.js";

const context = await createAppContext();
const server = createHttpApp(context);

server.listen(context.config.port, context.config.host, () => {
  console.log(`Autonomous Payment Agent listening on http://${context.config.host}:${context.config.port}`);
  console.log(`Payment mode: ${context.config.paymentMode}; network: ${context.config.defaultNetwork}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
