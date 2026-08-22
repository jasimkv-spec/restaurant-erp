import "dotenv/config";
import { createApp } from "./app";
import { ensurePlatformAdmin } from "./bootstrap/ensurePlatformAdmin";

const port = Number(process.env.PORT ?? 4000);

const app = createApp();

ensurePlatformAdmin()
  .catch((err) => console.error("[platform-admin] bootstrap failed:", err))
  .finally(() => {
    app.listen(port, () => {
      console.log(`Restaurant ERP MVP API listening on http://localhost:${port}`);
      console.log(`Health check: GET http://localhost:${port}/health`);
    });
  });
