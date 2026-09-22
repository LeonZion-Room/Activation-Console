"""激活中心客户端 SDK 示例：每日心跳校验，决定服务保活/关停"""
import sys
import requests

API = "https://<workers.dev域名>"   # 云端 Worker 地址   # 控制台地址
AUTH_KEY = "在控制台-设置页获取"        # 全局 X-Auth-Key
PROJECT_CODE = "svc-backup"          # 卡片登记的项目编码


def check(timeout: int = 10) -> bool:
    """True=允许运行；False/超时/异常=立即关停服务"""
    try:
        r = requests.get(
            f"{API}/api/v1/project/check",
            params={"project_code": PROJECT_CODE},
            headers={"X-Auth-Key": AUTH_KEY},
            timeout=timeout,
        )
        data = r.json()
        return data.get("code") == 0 and data["data"]["is_activate"] is True
    except Exception as e:
        print(f"[check] 校验失败，按不可激活处理: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    if check():
        print("激活通过 → 服务保活运行")
        sys.exit(0)
    else:
        print("校验未通过 → 立即关停服务并禁止自启")
        sys.exit(1)