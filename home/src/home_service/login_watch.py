"""B 站登录失效提醒（#37）。

每次读到 BeeBox 的 /v1/health 都看一眼 bilibili_login：变成 expired 时发一封邮件，
提醒到 BeeBox 控制台扫码登录。同一次失效只提醒一次（记在 meta 表里，重启不重发），
恢复成 valid / absent 后再失效会重新提醒。发信失败下次读到时再试。
"""

import logging

from .mailer import Mailer, MailError
from .store import Store

log = logging.getLogger(__name__)

META_KEY = "bilibili_login_notified"
SUBJECT = "B 站登录已失效：请到 BeeBox 控制台扫码登录"


class LoginWatch:
    def __init__(self, store: Store, mailer: Mailer, console_url: str):
        self.store, self.mailer, self.console_url = store, mailer, console_url

    async def observe(self, health: dict) -> None:
        state = health.get("bilibili_login")
        if state not in ("valid", "expired", "absent"):
            return
        last = self.store.get_meta(META_KEY)
        if state != "expired":
            if last != state:
                self.store.set_meta(META_KEY, state)
            return
        if last == "expired":
            return
        if not self.mailer.configured:
            log.warning("B 站登录已失效，但没有配置 SMTP，跳过提醒邮件")
            self.store.set_meta(META_KEY, "expired")
            return
        body = (f"BeeBox 报告 B 站登录已失效，需要登录才能看的 B 站视频会转写失败。\n\n"
                f"请打开 BeeBox 控制台的凭证页扫码登录：{self.console_url}\n")
        try:
            await self.mailer.send(SUBJECT, body)
        except MailError as e:
            log.warning("B 站登录失效提醒发送失败：%s", e.message)
            return
        self.store.set_meta(META_KEY, "expired")
