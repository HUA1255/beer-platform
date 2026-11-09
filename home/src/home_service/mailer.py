"""用 SMTP 发「录音已转写」通知邮件。

配置从 Settings 读（HOME_SMTP_* / HOME_MAIL_TO）；没配 SMTP 时调用方跳过发信。
smtplib 是同步库，发信包在 asyncio.to_thread 里，不阻塞事件循环。
"""

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage

log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30.0


class MailError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Mailer:
    def __init__(self, host: str, port: int = 465, security: str = "ssl",
                 user: str = "", password: str = "", mail_to: str = ""):
        self.host, self.port, self.security = host, port, security
        self.user, self.password, self.mail_to = user, password, mail_to

    @property
    def configured(self) -> bool:
        return bool(self.host and self.mail_to)

    async def send(self, subject: str, body: str) -> None:
        await asyncio.to_thread(self._send_sync, subject, body)

    def _send_sync(self, subject: str, body: str) -> None:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self.user or self.mail_to
        msg["To"] = self.mail_to
        msg.set_content(body)
        try:
            if self.security == "ssl":
                with smtplib.SMTP_SSL(self.host, self.port, timeout=TIMEOUT_SECONDS,
                                      context=ssl.create_default_context()) as smtp:
                    self._login(smtp)
                    smtp.send_message(msg)
            else:
                with smtplib.SMTP(self.host, self.port, timeout=TIMEOUT_SECONDS) as smtp:
                    if self.security == "starttls":
                        smtp.ehlo()
                        smtp.starttls(context=ssl.create_default_context())
                        smtp.ehlo()
                    self._login(smtp)
                    smtp.send_message(msg)
        except (OSError, smtplib.SMTPException) as e:
            raise MailError(f"发邮件失败：{e}") from e

    def _login(self, smtp: smtplib.SMTP) -> None:
        if self.user and self.password:
            smtp.login(self.user, self.password)
