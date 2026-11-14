import os
from dataclasses import dataclass
from pathlib import Path

from .beebox import check_base_url

SMTP_SECURITIES = ("ssl", "starttls", "none")


@dataclass(frozen=True)
class Settings:
    access_key: str          # Beer 调用时带的访问密钥（Authorization: Bearer）
    originals_dir: Path      # 录音原件本地暂存目录（NAS 上的 WebDAV 才是主副本）
    db_path: Path            # SQLite 状态库
    beebox_base_url: str     # BeeBox 基址，只写 http://<windows>:<端口>，不带路径（请求都以 /v1 开头）
    beebox_token: str        # 与 Windows 上的 BEEBOX_API_TOKEN 一致
    poll_interval: float = 5.0  # 跟进转写任务的轮询间隔（秒）
    health_interval: float = 1800.0  # 定时读 BeeBox /v1/health 的间隔（秒），用于 B 站登录失效提醒；0 关闭
    # opencode go（按类型摘要）：留空 API key 时摘要一步直接通过（no_summary）
    opencode_base: str = "https://opencode.ai"
    opencode_api_key: str = ""
    summary_model: str = "deepseek-v4.1-flash"
    # SMTP 通知邮件：host 或 mail_to 留空时跳过发信
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_security: str = "ssl"   # ssl | starttls | none
    smtp_user: str = ""
    smtp_password: str = ""
    mail_to: str = ""
    # 录音原件主副本走 NAS 的 WebDAV（2026-11-07 定：不用 SMB 挂载）。
    # base_url 要带上个人空间路径，例如 http://192.168.1.10:5005/your-space
    webdav_url: str = ""
    webdav_user: str = ""
    webdav_password: str = ""
    webdav_root: str = "录音原件"   # 原件在 WebDAV 根下的子目录

    @property
    def mail_configured(self) -> bool:
        return bool(self.smtp_host and self.mail_to)

    @classmethod
    def from_env(cls) -> "Settings":
        def need(name: str) -> str:
            value = os.environ.get(name, "").strip()
            if not value:
                raise RuntimeError(f"缺少环境变量 {name}")
            return value

        renamed = [old for old in ("HOME_ASR_BASE_URL", "HOME_ASR_TOKEN") if old in os.environ]
        if renamed:
            raise RuntimeError(f"{' / '.join(renamed)} 已改名为 HOME_BEEBOX_BASE_URL / HOME_BEEBOX_TOKEN（#37），"
                               "请更新 home-service.env")

        security = os.environ.get("HOME_SMTP_SECURITY", "ssl").strip().lower() or "ssl"
        if security not in SMTP_SECURITIES:
            raise RuntimeError(f"HOME_SMTP_SECURITY 只能是 {' / '.join(SMTP_SECURITIES)}")
        return cls(
            access_key=need("HOME_ACCESS_KEY"),
            originals_dir=Path(need("HOME_ORIGINALS_DIR")),
            db_path=Path(need("HOME_DB_PATH")),
            beebox_base_url=check_base_url(need("HOME_BEEBOX_BASE_URL")),
            beebox_token=need("HOME_BEEBOX_TOKEN"),
            poll_interval=float(os.environ.get("HOME_POLL_INTERVAL", "5")),
            health_interval=float(os.environ.get("HOME_BEEBOX_HEALTH_INTERVAL", "1800")),
            opencode_base=os.environ.get("HOME_OPENCODE_BASE", "https://opencode.ai").strip()
            or "https://opencode.ai",
            opencode_api_key=os.environ.get("HOME_OPENCODE_API_KEY", "").strip(),
            summary_model=os.environ.get("HOME_SUMMARY_MODEL", "deepseek-v4.1-flash").strip()
            or "deepseek-v4.1-flash",
            smtp_host=os.environ.get("HOME_SMTP_HOST", "").strip(),
            smtp_port=int(os.environ.get("HOME_SMTP_PORT", "465")),
            smtp_security=security,
            smtp_user=os.environ.get("HOME_SMTP_USER", "").strip(),
            smtp_password=os.environ.get("HOME_SMTP_PASSWORD", ""),
            mail_to=os.environ.get("HOME_MAIL_TO", "").strip(),
            webdav_url=os.environ.get("HOME_WEBDAV_URL", "").strip(),
            webdav_user=os.environ.get("HOME_WEBDAV_USER", "").strip(),
            webdav_password=os.environ.get("HOME_WEBDAV_PASSWORD", ""),
            webdav_root=os.environ.get("HOME_WEBDAV_ROOT", "录音原件").strip() or "录音原件",
        )
