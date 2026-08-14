import { ConfigProvider, Effect } from "effect"
import { AppConfig } from "./src/Config.ts"
Effect.runPromise(AppConfig.parse(ConfigProvider.fromEnv()) as any).then((c: any) => console.log("ok", c.port, c.devicePort), (e) => console.log("ERR", String(e).split("\n")[0]))
