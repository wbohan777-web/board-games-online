# 账号密码系统 vs 游客模式对比

## 当前状态：纯游客模式
- ✅ 无需注册，打开即玩
- ✅ 适合临时对局
- ❌ 刷新丢失身份
- ❌ 无法记录战绩
- ❌ 无法找回历史对局

## 方案A：添加可选账号系统（推荐）
### 特点
- 默认游客模式（保持低门槛）
- 可选注册账号（用户名+密码）
- 注册后自动登录
- 支持游客转正式账号

### 优势
- ✅ 保持新手友好
- ✅ 刷新不丢失身份
- ✅ 可以记录战绩/等级
- ✅ 支持好友系统
- ✅ 可以找回历史对局

### 技术实现
```javascript
// 用户状态
type User = {
  id: string;          // UUID
  username?: string;   // 注册后有
  passwordHash?: string;
  isGuest: boolean;    // 游客 or 注册用户
  displayName: string; // 显示名称
  stats: {            // 战绩
    gamesPlayed: number;
    wins: number;
  };
  createdAt: number;
}

// JWT Token 存储在 localStorage
// 刷新后自动登录
```

### 改动范围
1. **后端**：
   - 添加用户表（内存 Map 或 MongoDB）
   - 添加 `/api/auth/register`
   - 添加 `/api/auth/login`
   - JWT 生成与验证
   
2. **前端**：
   - 登录/注册界面（可选）
   - Token 管理
   - 显示用户信息

## 方案B：改进游客模式（快速方案）
### 特点
- 保持游客模式
- 用 localStorage 持久化游客身份
- 自动生成唯一 guestId

### 优势
- ✅ 实现简单
- ✅ 刷新不丢失
- ❌ 清除浏览器数据会丢失
- ❌ 无法跨设备

### 技术实现
```javascript
// 首次访问生成 guestId
if (!localStorage.getItem('guestId')) {
  localStorage.setItem('guestId', crypto.randomUUID());
  localStorage.setItem('guestName', userName);
}

// 每次连接带上 guestId
send({ 
  type: 'hello', 
  guestId: localStorage.getItem('guestId'),
  name: localStorage.getItem('guestName')
});
```

## 建议：方案A（可选账号系统）

理由：
1. **灵活性**：新手游客模式，老玩家账号系统
2. **用户留存**：战绩和等级激励回访
3. **社交功能**：好友、排行榜需要账号
4. **未来扩展**：为付费功能（皮肤、头像）铺路

## 实施步骤
1. **阶段1**（1-2小时）：改进游客模式（方案B）- 快速修复刷新问题
2. **阶段2**（4-6小时）：添加可选账号系统（方案A）
3. **阶段3**（2-3小时）：添加战绩、排行榜

---

**你希望我先做哪个？**
- 方案B：快速修复刷新问题（20分钟）
- 方案A：完整账号系统（3-4小时）
