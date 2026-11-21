from typing import Annotated

from fastapi import APIRouter, Path, Query

from backend.app.admin.schema.token import GetTokenDetail
from backend.common.enums import StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsSuperUser
from backend.common.security.session import EndReason, SessionClient, session_store
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.timezone import timezone

router = APIRouter()


@router.get('', summary='获取在线用户', dependencies=[DependsSuperUser])
async def get_sessions(
    username: Annotated[str | None, Query(description='用户名')] = None,
) -> ResponseSchemaModel[list[GetTokenDetail]]:
    """
    全站还活着的会话（#138）

    🔴 读的是会话索引，不再 SCAN access token 的 key。原来那样做，access token 一过期
    （那时是 1 天）、refresh token 还活着（7 天）的会话就**从列表上消失**，管理员看不见也踢不掉，
    而它随时能刷新复活（实测：删掉 access key 后列表里没了，refresh 之后又冒出来）
    """
    rows = await session_store.list_active()
    # 在线 = 这个会话的 socket 集合还在（带 TTL，持有连接的进程续期，#401）。不再读全站集合 `fba:token_online`：
    # 它没法按成员过期，进程被杀之后里面的会话永远「在线」
    async with redis_client.pipeline(transaction=False) as pipe:
        for row in rows:
            pipe.exists(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:session:{row["session_uuid"]}')
        online = await pipe.execute()
    online_sessions = {row['session_uuid'] for row, alive in zip(rows, online, strict=True) if alive}
    data: list[GetTokenDetail] = []
    for row in rows:
        # swagger 调试口的会话不进列表（非 prod 才有那个口，见 auth.py）
        if row['client'] == SessionClient.swagger:
            continue
        if username is not None and row.get('username') != username:
            continue
        last_active = int(row['last_active'])
        expire_at = min(last_active + int(row['idle']), int(row['expire_at']))
        data.append(
            GetTokenDetail(
                id=int(row['uid']),
                session_uuid=row['session_uuid'],
                client=row['client'],
                username=row.get('username') or '未知',
                nickname=row.get('nickname') or '未知',
                ip=row.get('ip') or '未知',
                os=row.get('os') or '未知',
                browser=row.get('browser') or '未知',
                device=row.get('device') or '未知',
                status=StatusType.enable if row['session_uuid'] in online_sessions else StatusType.disable,
                last_login_time=row.get('last_login_time') or '未知',
                last_active_time=timezone.from_datetime(timezone.to_utc(last_active)),
                expire_time=timezone.from_datetime(timezone.to_utc(expire_at)),
            )
        )
    return response_base.success(data=data)


@router.delete(
    '/{pk}',
    summary='强制下线',
    dependencies=[DependsSuperUser],
)
async def delete_session(
    pk: Annotated[int, Path(description='用户 ID')],
    session_uuid: Annotated[str, Query(description='会话 UUID')],
) -> ResponseModel:
    # 用户 ID 要和会话对得上：对不上的话，路径里的 pk 就只是摆设
    if await session_store.user_of(session_uuid) != pk:
        raise errors.NotFoundError(msg=t('error.session.not_found'))
    await session_store.revoke(session_uuid, EndReason.kicked)
    return response_base.success()
