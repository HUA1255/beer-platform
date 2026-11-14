// 插件配置项（Schemastery）。部署相关、可能变的参数都放这里，不写死在代码里。
// 宿主按 cordis.patch.yml 或 profile 配置传入；测试里通过 startBeer({ config }) 覆盖。
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  root: Schema.string().required().description('Beer 自己的数据目录（库位置记忆等），由 cordis.patch.yml 里的 dshHomePath("beer") 给出'),
  homeApiBase: Schema.string().default('http://mac-mini:8787').description('家里服务（Mac mini）的地址'),
  opencodeGoBase: Schema.string().default('https://opencode.ai').description('opencode go 的服务地址（模型与限额）'),
  platformVersionModel: Schema.string().default('deepseek-v4.1-flash').description('生成平台版本用的文本模型'),
  reminderApiBase: Schema.string().default('https://remind.example.com').description('云端提醒服务（Cloudflare Worker）的地址'),
  rinApiBase: Schema.string().default('').description('Rin 博客接口地址'),
  keychainService: Schema.string().default('beer').description('macOS 钥匙串里条目的服务名'),
  audioCacheLimitGB: Schema.number().default(5).description('录音缓存上限（GB），超过时按最久没听删除'),
})

/** 面板可以看到的配置项（不含数据目录等本机细节）。 */
export const PUBLIC_CONFIG_KEYS = ['homeApiBase', 'reminderApiBase', 'rinApiBase', 'opencodeGoBase', 'audioCacheLimitGB']
