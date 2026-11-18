# 完整账号系统实施方案

## 技术栈（零依赖）
- 后端：内存 Map 存储用户（重启后丢失，但可快速升级到 MongoDB）
- 认证：简单的 Token（UUID）存在 localStorage
- 密码：bcrypt 式简单哈希（自己实现）

## 数据结构

```javascript
// 用户
{
  id: string;          // UUID
  username: string;    // 用户名（唯一）
  passwordHash: string;// 密码哈希
  displayName: string; // 显示名称
  createdAt: number;
  lastLoginAt: number;
  stats: {
    gamesPlayed: number;
    wins: number;
    forestGames: number;
    photoGames: number;
  }
}

// Token
{
  token: string;       // UUID
  userId: string;
  expiresAt: number;
}
```

## API 端点

```
POST /api/auth/register
  body: { username, password, displayName }
  返回: { token, user }

POST /api/auth/login
  body: { username, password }
  返回: { token, user }

GET /api/auth/me
  header: Authorization: Bearer <token>
  返回: { user }

POST /api/auth/logout
  header: Authorization: Bearer <token>
  返回: { ok: true }
```

## 前端流程

```
首次访问 → 登录/注册页
         ↓
    输入用户名密码
         ↓
    获取 token 存 localStorage
         ↓
    进入大厅（永久登录状态）
```

## 实施步骤

1. **后端用户管理**（30 分钟）
   - User Map 和 Token Map
   - 密码哈希函数
   - 注册/登录/验证 API

2. **前端登录界面**（30 分钟）
   - 登录/注册表单
   - Token 管理
   - 自动登录逻辑

3. **集成到现有系统**（40 分钟）
   - WebSocket 握手带 token
   - 房间创建绑定用户
   - 显示用户信息

4. **测试修复**（20 分钟）
   - 两人开局
   - 刷新保持登录
   - 多设备登录

## 开始实施！
