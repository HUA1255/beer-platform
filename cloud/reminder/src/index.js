// Worker 入口：只做接线，业务在 service.js。
import { createService } from './service.js'

export default {
  fetch(request, env) {
    return createService({ db: env.DB, email: env.EMAIL, env }).fetch(request)
  },
  async scheduled(_event, env) {
    await createService({ db: env.DB, email: env.EMAIL, env }).tick()
  },
}
