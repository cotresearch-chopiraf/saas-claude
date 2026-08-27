import "dotenv/config";
import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`contractor-os API listening on http://localhost:${port}`);
});
