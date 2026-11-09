// 所有挂在 /api/beer/ 下的模块。新模块：写 src/modules/<名字>.js，导出
// `export function register(router, ctx) { router.get('/<名字>/...', ...) }`，再加到下面的数组里。
// ctx 里有：config（插件配置项）、secrets（钥匙串）、state（数据目录里的小状态）、now、fetch。
// 需要库根目录时用 vault.js 的 resolveVault(ctx)。
import * as vault from './vault.js'
import * as panel from './panel.js'
import * as settings from './settings.js'
import * as library from './library.js'
import * as quota from './quota.js'
import * as recordings from './recordings.js'
import * as audio from './audio.js'
import * as trash from './trash.js'
import * as search from './search.js'
import * as articles from './articles.js'
import * as materials from './materials.js'
import * as materialImport from './material-import.js'
import * as versions from './versions.js'
import * as topics from './topics.js'
import * as publish from './publish.js'
import * as publishPackages from './publish-packages.js'
import * as rules from './rules.js'
import * as home from './home.js'
import * as clientAssets from './client-assets.js'

export const modules = [
  vault.register,
  panel.register,
  settings.register,
  library.register,
  quota.register,
  recordings.register,
  audio.register,
  trash.register,
  search.register,
  articles.register,
  materials.register,
  materialImport.register,
  versions.register,
  topics.register,
  publish.register,
  publishPackages.register,
  rules.register,
  home.register,
  clientAssets.register,
]
