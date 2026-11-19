"""The chat detail route against Postgres and the shared cache."""

from collections.abc import Sequence
from io import BytesIO
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import update
from sqlalchemy.orm import Session

from onyx.cache.factory import get_cache_backend
from onyx.chat.chat_processing_checker import ChatTurnAdmission
from onyx.configs.constants import (
    CHAT_SESSION_ID_FILE_METADATA_KEY,
    DEFAULT_PERSONA_ID,
    FileOrigin,
    MessageType,
)
from onyx.db.chat import create_new_chat_message, get_or_create_root_message
from onyx.db.engine.sql_engine import get_session_with_current_tenant
from onyx.db.models import ChatMessage, ChatSession, FileRecord, User
from onyx.file_store.file_store import (
    FILE_SIZE_MISSING_SENTINEL,
    get_default_file_store,
)
from onyx.file_store.models import ChatFileType, FileDescriptor
from onyx.file_store.utils import save_chat_output_file
from onyx.server.query_and_chat import chat_backend
from tests.external_dependency_unit.conftest import MakeTestUser


@pytest.fixture
def owner(make_test_user: MakeTestUser) -> User:
    return make_test_user("chat-session-detail")


def test_an_idle_chat_detail_holds_the_saves_of_the_turn_that_ended(
    db_session: Session, owner: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    chat = ChatSession(
        id=uuid4(),
        user_id=owner.id,
        persona_id=DEFAULT_PERSONA_ID,
        description="Read order",
    )
    db_session.add(chat)
    db_session.flush()
    root = ChatMessage(
        chat_session_id=chat.id,
        message="",
        token_count=0,
        message_type=MessageType.SYSTEM,
    )
    db_session.add(root)
    db_session.flush()
    question = ChatMessage(
        parent_message_id=root.id,
        chat_session_id=chat.id,
        message="Question",
        token_count=1,
        message_type=MessageType.USER,
    )
    db_session.add(question)
    db_session.commit()
    question_id = question.id

    turn = ChatTurnAdmission(get_cache_backend())
    turn.claim(chat.id)
    read_messages = chat_backend.get_chat_messages_by_session

    def read_then_end_turn(**kwargs: Any) -> Sequence[ChatMessage]:
        messages = read_messages(**kwargs)
        # The turn saves its reply and then releases admission, after the
        # route has read the messages.
        with get_session_with_current_tenant() as run_session:
            run_session.add(
                ChatMessage(
                    parent_message_id=question_id,
                    chat_session_id=chat.id,
                    message="Reply",
                    token_count=1,
                    message_type=MessageType.ASSISTANT,
                )
            )
            run_session.commit()
        turn.release()
        return messages

    monkeypatch.setattr(
        chat_backend, "get_chat_messages_by_session", read_then_end_turn
    )
    try:
        detail = chat_backend.get_chat_session(
            chat.id, user=owner, db_session=db_session
        )
    finally:
        turn.release()

    # A client stores an idle page as final, so an idle page must hold the reply.
    assert detail.is_processing or "Reply" in [
        message.message for message in detail.messages
    ]


def _new_chat(
    db_session: Session, owner: User, spawned_by: ChatMessage | None = None
) -> ChatSession:
    chat = ChatSession(
        id=uuid4(),
        user_id=owner.id,
        persona_id=DEFAULT_PERSONA_ID,
        description="Published files",
        spawned_by_message_id=spawned_by.id if spawned_by is not None else None,
    )
    db_session.add(chat)
    db_session.commit()
    return chat


def _add(
    db_session: Session,
    parent: ChatMessage,
    message_type: MessageType,
    files: list[FileDescriptor] | None = None,
) -> ChatMessage:
    return create_new_chat_message(
        chat_session_id=parent.chat_session_id,
        parent_message=parent,
        message=message_type.value,
        token_count=1,
        message_type=message_type,
        db_session=db_session,
        files=files,
    )


def _publish(chat: ChatSession, path: str, title: str | None = None) -> FileDescriptor:
    name = path.rsplit("/", 1)[-1]
    file_id = save_chat_output_file(
        name.encode(),
        display_name=name,
        file_type="text/markdown",
        file_origin=FileOrigin.CHAT_ARTIFACT,
        chat_session_id=chat.id,
        published_path=path,
        published_title=title,
    )
    return FileDescriptor(id=file_id, type=ChatFileType.PLAIN_TEXT, name=name)


@pytest.mark.usefixtures("initialize_file_store")
def test_the_latest_page_lists_the_branch_files_with_their_stamped_path_and_title(
    db_session: Session, owner: User
) -> None:
    """The list holds the published files of the branch's answers and of the
    subagent sessions that they spawned, recursively, with the path and title
    from the file record. It leaves out another branch's files, files that are
    not published files, files published without a stamped path, and files
    whose object is missing. An answer whose files are a JSON null adds
    nothing."""
    chat = _new_chat(db_session, owner)
    report = _publish(chat, "/w/report.md", "Report")
    image_id = save_chat_output_file(
        b"png",
        display_name="image.png",
        file_type="image/png",
        file_origin=FileOrigin.CHAT_IMAGE_GEN,
        chat_session_id=chat.id,
    )
    # Published before files recorded their path.
    unstamped_id = get_default_file_store().save_file(
        content=BytesIO(b"old"),
        display_name="old.md",
        file_origin=FileOrigin.CHAT_ARTIFACT,
        file_type="text/markdown",
        file_metadata={CHAT_SESSION_ID_FILE_METADATA_KEY: str(chat.id)},
    )
    missing = _publish(chat, "/w/missing.md")
    db_session.execute(
        update(FileRecord)
        .where(FileRecord.file_id == missing["id"])
        .values(file_size=FILE_SIZE_MISSING_SENTINEL)
    )
    db_session.commit()

    question = _add(
        db_session, get_or_create_root_message(chat.id, db_session), MessageType.USER
    )
    first_answer = _add(
        db_session,
        question,
        MessageType.ASSISTANT,
        [
            report,
            FileDescriptor(id=image_id, type=ChatFileType.IMAGE, name="image.png"),
            FileDescriptor(id=unstamped_id, type=ChatFileType.PLAIN_TEXT),
            missing,
        ],
    )
    follow_up = _add(db_session, first_answer, MessageType.USER)
    _add(db_session, follow_up, MessageType.ASSISTANT, [_publish(chat, "/w/other.md")])
    last_answer = _add(db_session, follow_up, MessageType.ASSISTANT, None)

    # A subagent of the last answer publishes, and so does its own subagent.
    child = _new_chat(db_session, owner, spawned_by=last_answer)
    child_answer = _add(
        db_session,
        _add(
            db_session,
            get_or_create_root_message(child.id, db_session),
            MessageType.USER,
        ),
        MessageType.ASSISTANT,
        [_publish(child, "/w/report.md", "Report from a subagent")],
    )
    grandchild = _new_chat(db_session, owner, spawned_by=child_answer)
    _add(
        db_session,
        _add(
            db_session,
            get_or_create_root_message(grandchild.id, db_session),
            MessageType.USER,
        ),
        MessageType.ASSISTANT,
        [_publish(grandchild, "/w/chart.md")],
    )

    detail = chat_backend.get_chat_session(
        chat.id, limit=2, user=owner, db_session=db_session
    )

    assert [
        (file.path, file.title, file.name, file.size, file.message_id)
        for file in detail.published_files
    ] == [
        ("/w/report.md", "Report", "report.md", len(b"report.md"), first_answer.id),
        (
            "/w/report.md",
            "Report from a subagent",
            "report.md",
            len(b"report.md"),
            last_answer.id,
        ),
        ("/w/chart.md", None, "chart.md", len(b"chart.md"), last_answer.id),
    ]


@pytest.mark.usefixtures("initialize_file_store")
def test_only_a_latest_page_or_shared_load_lists_the_files(
    db_session: Session, owner: User
) -> None:
    """An older page and an owner's unpaged load carry no list: the client does
    not read it there. A chat without published files has an empty list."""
    empty = _new_chat(db_session, owner)
    _add(
        db_session,
        _add(
            db_session,
            get_or_create_root_message(empty.id, db_session),
            MessageType.USER,
        ),
        MessageType.ASSISTANT,
    )
    assert (
        chat_backend.get_chat_session(
            empty.id, limit=2, user=owner, db_session=db_session
        ).published_files
        == []
    )

    chat = _new_chat(db_session, owner)
    question = _add(
        db_session, get_or_create_root_message(chat.id, db_session), MessageType.USER
    )
    answer = _add(
        db_session, question, MessageType.ASSISTANT, [_publish(chat, "/w/a.md")]
    )
    later = _add(db_session, answer, MessageType.USER)

    older_page = chat_backend.get_chat_session(
        chat.id, limit=1, before_message_id=later.id, user=owner, db_session=db_session
    )
    assert answer.id in {message.message_id for message in older_page.messages}
    assert older_page.published_files == []
    unpaged = chat_backend.get_chat_session(chat.id, user=owner, db_session=db_session)
    assert unpaged.published_files == []
    assert [
        file.path
        for file in chat_backend.get_chat_session(
            chat.id, limit=1, user=owner, db_session=db_session
        ).published_files
    ] == ["/w/a.md"]
