# GitHub Actions 和构建指南

本文档包含 GitHub Actions CI/CD 配置和本地跨平台构建的完整说明。

---

## 📋 GitHub Actions 配置

项目已配置 **2 个** GitHub Actions 工作流,**不包含任何自动触发的定时任务**。

### 工作流列表

| 工作流 | 文件 | 触发方式 |
|--------|------|----------|
| **Build Desktop App** | `build-desktop.yml` | 1. 推送版本标签<br>2. 手动触发 |
| **CI** | `ci.yml` | 1. Pull Request<br>2. 手动触发 |

---

## 🚀 使用 GitHub Actions

### 1. 发布正式版本 (推送标签触发)

```bash
# 创建版本标签
git tag -a v1.0.0 -m "Release 1.0.0"

# 推送标签到 GitHub (自动触发构建)
git push origin v1.0.0
```

**自动执行**:
- ✅ 在 Windows、macOS、Linux 上并行构建
- ✅ 创建 GitHub Release
- ✅ 上传所有平台的安装包

**发布地址**:
```
https://github.com/feuyeux/stream-resilience-lab/releases/tag/v1.0.0
```

### 2. 手动触发构建

#### 通过 GitHub Web 界面

1. 访问 `https://github.com/feuyeux/stream-resilience-lab/actions`
2. 点击左侧 **Build Desktop App**
3. 点击右上角 **Run workflow** 下拉菜单
4. 选择分支 (通常是 `main`)
5. (可选) 输入自定义版本号,如 `srl-1.0.0`
6. 点击绿色的 **Run workflow** 按钮

#### 通过 GitHub CLI

```bash
# 使用默认设置
gh workflow run build-desktop.yml

# 指定自定义版本号
gh workflow run build-desktop.yml -f version=srl-1.0.0

# 查看运行状态
gh run watch
```

### 3. Pull Request 自动测试

创建或更新 Pull Request 时,CI 工作流会自动运行:
- ✅ 类型检查
- ✅ 单元测试
- ✅ 烟雾测试
- ✅ 多平台构建验证

只有所有检查通过,PR 才会显示绿色对勾。

---

## ⚙️ 工作流详情

### Build Desktop App

**目的**: 构建和发布跨平台安装包

**触发条件**:
```yaml
on:
  push:
    tags:
      - 'v*.*.*'  # 如 v1.0.0
      - 'srl-*'   # 如 srl-20260626
  workflow_dispatch:  # 手动触发
```

**构建产物**:
- Windows: `Stream Resilience Debugger Setup *.exe` (~110 MB)
- macOS: `Stream Resilience Debugger-*.dmg` (~120 MB)
- Linux: `*.AppImage` (~130 MB) + `*.deb` (~120 MB)

**执行时间**: ~10-15 分钟

### CI

**目的**: 代码质量保证

**触发条件**:
```yaml
on:
  pull_request:
    branches: [main, master, develop]
  workflow_dispatch:  # 手动触发
```

**检查内容**:
- TypeScript 类型检查
- 单元测试 (Vitest)
- 场景烟雾测试
- 跨平台构建验证

**执行时间**: ~5-8 分钟

---

## 🔍 监控和调试

### 查看构建状态

```bash
# 列出最近的工作流运行
gh run list

# 查看特定运行的详情
gh run view <run-id>

# 实时监控
gh run watch

# 下载构建日志
gh run view <run-id> --log > build.log
```

### 下载构建产物

**方法 1: 从 Releases 下载** (推送标签触发的构建)
```bash
gh release download v1.0.0
```

**方法 2: 从 Artifacts 下载** (手动触发的构建)
```bash
# 查看最近的运行
gh run list --workflow=build-desktop.yml

# 下载 artifacts
gh run download <run-id>
```

---

## 🏗️ 本地跨平台构建

### 构建命令

```bash
# 构建当前平台
npm run desktop:dist

# 构建所有平台 (Windows, macOS, Linux)
npm run desktop:dist:all

# 单独构建特定平台
npm run desktop:dist:win    # Windows NSIS 安装程序
npm run desktop:dist:mac    # macOS DMG
npm run desktop:dist:linux  # Linux AppImage 和 deb
```

### 平台支持矩阵

| 构建主机 \ 目标平台 | Windows | macOS | Linux |
|---------------------|---------|-------|-------|
| **Windows**         | ✅ 完全支持 | ⚠️ 限制 | ⚠️ 限制 |
| **macOS**           | ✅ 完全支持 | ✅ 完全支持 | ✅ 完全支持 |
| **Linux**           | ✅ 完全支持 | ❌ 不支持 | ✅ 完全支持 |

**说明**:
- ✅ **完全支持**: 可以生成完整、可分发的安装包
- ⚠️ **限制**: 可以交叉编译但可能缺少某些功能或遇到问题
- ❌ **不支持**: electron-builder 不支持该组合

### 从 Windows 交叉编译的限制

#### macOS DMG

从 Windows 构建 macOS DMG 存在以下限制:

1. **代码签名**: 无法在 Windows 上对 macOS 应用进行代码签名
2. **DMG 格式**: 某些 DMG 特性需要 macOS 原生工具
3. **建议**: 在 macOS 机器上或使用 GitHub Actions 构建 macOS 版本

#### Linux (AppImage/deb)

从 Windows 构建 Linux 包是可行的,但可能遇到:

1. **下载超时**: Electron Linux 二进制文件较大,可能因网络问题超时
2. **权限问题**: 某些 Linux 特定的文件权限可能无法正确设置

**解决方案**:

```bash
# 增加 electron-builder 下载超时
set ELECTRON_BUILDER_NETWORK_TIMEOUT=1800000
npm run desktop:dist:linux

# 或者预先下载 Electron 缓存
npm install -g electron
electron --version  # 预下载 Electron 二进制
```

---

## 📦 输出文件

构建完成后,安装包将位于 `dist/packages/` 目录:

### Windows
- `Stream Resilience Debugger Setup srl-YYYYMMDD.HHMMSS.exe` - NSIS 安装程序
- `*.exe.blockmap` - 用于增量更新

### macOS
- `Stream Resilience Debugger-*.dmg` - macOS 磁盘映像

### Linux
- `stream-resilience-debugger-*.AppImage` - 通用 Linux 应用
- `stream-resilience-debugger_*_amd64.deb` - Debian/Ubuntu 包

---

## 🏷️ 版本命名

构建版本基于时间戳自动生成,格式为 `srl-YYYYMMDD.HHMMSS`:

- `srl` - Stream Resilience Lab 缩写
- `YYYYMMDD` - 年月日
- `HHMMSS` - 时分秒

可以通过环境变量覆盖:

```bash
# Windows
set SRL_BUILD_VERSION=srl-1.0.0-beta
npm run desktop:dist

# macOS/Linux
export SRL_BUILD_VERSION=srl-1.0.0-beta
npm run desktop:dist
```

---

## 🎯 典型工作流程

### 场景 1: 发布新版本 (推荐)

```bash
# 1. 确保测试通过
npm test && npm run typecheck

# 2. 更新版本号和 CHANGELOG
npm version 1.0.0
# 编辑 CHANGELOG.md

# 3. 提交变更
git add .
git commit -m "chore: bump version to 1.0.0"
git push origin main

# 4. 创建并推送标签
git tag -a v1.0.0 -m "Release 1.0.0"
git push origin v1.0.0

# 5. GitHub Actions 自动在 3 个平台上构建并发布
# 等待 10-15 分钟
```

### 场景 2: 本地快速测试

```bash
# 只构建当前平台
npm run desktop:dist

# 检查输出
ls dist/packages/
```

### 场景 3: 手动触发 CI 构建

```bash
# 手动触发,输入自定义版本号
gh workflow run build-desktop.yml -f version=test-build-20260626

# 等待构建完成后下载 artifacts (不会创建 Release)
gh run download <run-id>
```

---

## 🔧 疑难解答

### Windows 上构建失败,提示权限错误

**原因**: 正在运行的桌面应用锁定了文件

**解决方案**:
```bash
# 关闭所有正在运行的 desktop 实例
# 清理旧的构建文件
rd /s /q dist\packages\win-unpacked
npm run desktop:dist:win
```

### 下载 Electron 超时

**原因**: 网络速度慢或不稳定

**解决方案**:
```bash
# Windows - 使用国内镜像 (可选)
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

# 或者预先下载 Electron
npm install -g electron@42.4.1
```

### macOS 代码签名失败

**原因**: 在非 macOS 系统上构建或缺少证书

**解决方案**:
- 在 macOS 机器上构建
- 使用 GitHub Actions (推荐)
- 或在 electron-builder 配置中设置 `mac.identity: null` 跳过签名 (仅用于开发/测试)

### GitHub Actions 构建失败

**解决方案**:
```bash
# 查看详细日志
gh run view <run-id> --log-failed

# 在本地复现问题
npm run desktop:dist

# 修复后重新推送标签或手动触发
```

---

## 📊 资源使用

### GitHub Actions 免费额度

**公开仓库**: ✅ 无限制  
**私有仓库**: 每月 2,000 分钟 (Free plan)

### 预估用量 (私有仓库)

| 活动 | 频率 | 单次分钟 | 月用量 |
|------|------|----------|--------|
| CI (PR) | ~10 次/月 | 5 分钟 | ~50 分钟 |
| Release Build | ~2 次/月 | 10 分钟 | ~20 分钟 |
| **总计** | - | - | **~70 分钟/月** |

远低于免费额度! ✅

---

## ✅ 配置优点

1. **可控性**: 所有构建都需要明确的触发动作
2. **节省资源**: 不会消耗不必要的 GitHub Actions 分钟数
3. **清晰明确**: 只在需要时构建,避免构建垃圾
4. **灵活性**: 可以手动控制何时构建和发布
5. **跨平台**: GitHub Actions 自动处理 3 个平台的构建

---

## ❌ 已移除的功能

为了避免不必要的自动触发,以下功能已被移除:

- ❌ **Nightly 自动构建**: 不再每天自动构建开发版本
- ❌ **自动清理**: 不再自动清理旧的 artifacts
- ❌ **Push 触发 CI**: 推送到主分支不再自动运行 CI

---

## 📝 常见问题

### Q: 如何触发一次测试构建?

A: 使用手动触发,输入测试版本号:
```bash
gh workflow run build-desktop.yml -f version=test-build
```
构建完成后从 Artifacts 下载,不会创建 Release。

### Q: 为什么推送代码不触发 CI?

A: 当前配置只在 PR 时触发 CI,推送到主分支不会触发。如需手动测试:
```bash
gh workflow run ci.yml
```

### Q: 本地构建和 GitHub Actions 构建有什么区别?

A:
- **本地构建**: 只能构建当前平台,适合快速测试
- **GitHub Actions**: 自动在 3 个平台上构建,适合正式发布

### Q: 构建失败怎么办?

A:
1. 查看 GitHub Actions 页面的错误日志
2. 在本地复现问题: `npm run desktop:dist`
3. 修复后重新推送标签或手动触发

---

## 📚 参考资料

- [GitHub Actions 官方文档](https://docs.github.com/en/actions)
- [electron-builder 文档](https://www.electron.build/)
- [electron-builder 多平台构建](https://www.electron.build/multi-platform-build)
- [Electron 发布指南](https://www.electronjs.org/docs/latest/tutorial/application-distribution)

---

**最后更新**: 2026-06-26  
**配置**: 简化版 - 无自动定时触发
