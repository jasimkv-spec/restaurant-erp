import "dotenv/config";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 4000);

const app = createApp();

app.listen(port, () => {
  console.log(`Restaurant ERP MVP API listening on http://localhost:${port}`);
  console.log(`Health check: GET http://localhost:${port}/health`);
});
