# 自建邮件发送(域名邮箱)指南

目标:用你自己的域名(如 `lets.example.com`)作为发件邮箱后缀,给新成员发邀请码/系统通知。本项目已内置 SMTP 客户端(nodemailer),只需要一个“能发信的邮箱账号”。

## 一、开源方案怎么选

| 方案 | 适用 | 一句话评价 |
|---|---|---|
| **Stalwart** (推荐·轻) | 单台 VPS、主要发信+少量收信 | Rust 单二进制 + Web 管理台;内置 SPF/DKIM/DMARC 全套签名与校验;内存 < 256MB 即可跑 |
| **Mailcow** (推荐·全家桶) | 要 webmail、群组、域名的完整邮局 | Docker Compose 一键;SOGo webmail;DKIM 一键生成;4GB+ 内存 |
| Mailu | 轻量邮局,模块化 | 比 Mailcow 省资源,功能略少 |
| Postal | 纯发送(事务邮件) | 自建版 Mailgun:API/模板/webhook,收信弱 |
| maddy | 单二进制极简 SMTP | 适合只发不收的小脚本团队,无 web UI |

结论:**要一个像样的邮箱后缀 → Stalwart(省心)或 Mailcow(功能全)**;只发通知 → Stalwart / Postal 都够。

## 二、搭建 Stalwart(最短路径)

```bash
# 1. VPS(Ubuntu 22.04/Debian 12,1C1G 起步)
curl -sSf https://get.stalwart.mail/linux.sh | sh    # 安装向导:设置主域名与管理员密码
# 2. 登录 http://VPS_IP:8080 → 管理 UI
# 3. Directory 里新建账号,如 invite@lets.example.com
# 4. Settings → DKIM → 为 lets.example.com 生成并“Apply”,得到 DNS 记录列表
```

## 三、DNS 三件套 + PTR(决定能不能进收件箱)

| 记录 | 示例值 | 作用 |
|---|---|---|
| SPF(TXT `@`) | `v=spf1 ip4:你的VPS_IP ~all` | 声明谁有权以你域名发信 |
| DKIM(TXT `stalwart._.domainkey` 等) | Stalwart/Mailcow 生成的公钥 | 邮件防篡改签名 |
| DMARC(TXT `_dmarc`) | `v=DMARC1; p=quarantine; rua=mailto:postmaster@lets.example.com` | 防伪造 + 收失败报告 |
| PTR(rDNS) | 把 VPS_IP 反解到 `mail.lets.example.com` | 云厂商控制台/工单设置,极重要 |
| A | `mail.lets.example.com` → VPS_IP | MX/服务器地址 |

> 三件套缺失任意一个,Gmail/Outlook/QQ 大概率直接丢进垃圾箱或拒收。

## 四、端口与防火墙

- 国内云(阿里云/腾讯云)**默认封 25 端口出站** —— 申请解封费时,建议:
  - 收其他邮件服务器的来信必须 25(入站不受影响);**发信走 465/587** 需要上表中转,或直接把 VPS 放在海外(香港/新加坡/日本,延迟也对亚洲玩家更好)
- 安全组放行:25(入)、465、587、993、143、8080(Stalwart 管理)

## 五、冷启动信誉养号

1. 新 IP + 新域名没有信誉,先发到自己的 Gmail/QQ/Outlook,收进收件箱后标记“非垃圾邮件”
2. 前两周每天几十封级别的小量,不要一天猛发几百封
3. `https://www.mail-tester.com` 随机地址测一封,10 分满分再开始正式使用
4. Google Postmaster Tools / Microsoft SNDS 可监控域名信誉(可选)

## 六、接入本项目(2 分钟)

`.env` 里加:

```bash
SMTP_HOST=mail.lets.example.com   # Stalwart/Mailcow 告诉你的 SMTP 地址
SMTP_PORT=465                      # 465=SSL;587 用 STARTTLS
SMTP_USER=invite@lets.example.com  # 上文创建的发件账号
SMTP_PASS=******
SMTP_FROM=Let's Log !n <invite@lets.example.com>   # 显示的发件人
```

`docker compose up -d --build` 重启后:
- 「管理后台 → 邀请码 → + 生成邀请码」弹层会出现 **发送到邮箱** 字段(未配置 SMTP 时自动隐藏)
- 生成 succeeds 时勾选邮箱即直发;发送失败不影响码本身,审计里记 `invite_email_failed`

> 不想自建?把 SMTP_* 指到任何支持 SMTP 的服务商(Resend / Mailgun / 阿里云邮件推送)同样可用,本项目只说 SMTP 协议,不绑定厂商。
