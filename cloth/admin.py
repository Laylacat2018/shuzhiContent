"""服务器上重置账号密码（忘记 admin 密码时用）。

sudo runuser -u cloth -- env CLOTH_DATA=/var/lib/cloth-v2 /opt/cloth-v2/venv/bin/python -m cloth.admin reset-password admin
"""
import getpass
import sys


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "reset-password":
        sys.exit("用法：python -m cloth.admin reset-password <账号>")
    from cloth.app.core import hash_pw, store
    u = next((x for x in store.list("users") if x["username"] == sys.argv[2]), None)
    if not u:
        sys.exit("账号不存在")
    pw = getpass.getpass("新密码（至少 8 位）：")
    if len(pw) < 8 or pw != getpass.getpass("再输入一次："):
        sys.exit("两次不一致或少于 8 位")
    store.update("users", u["id"], {"pw": hash_pw(pw), "active": True})
    for s in store.list("sessions", user_id=u["id"]):
        store.delete("sessions", s["id"])
    print(f"已重置 {u['username']} 的密码")


if __name__ == "__main__":
    main()
