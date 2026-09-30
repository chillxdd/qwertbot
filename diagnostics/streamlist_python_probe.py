#!/usr/bin/env python3
"""Minimal YouTube liveChatMessages.streamList probe using Python grpcio.

The parent QwertBot process supplies a liveChatId and short-lived OAuth access
 token through environment variables. The probe emits JSON-lines telemetry only;
 it never logs token contents or chat message text.
"""

import json
import os
import signal
import sys
from datetime import datetime, timezone

try:
    import grpc
    from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
except Exception as exc:  # pragma: no cover - parent environment check reports this
    print(json.dumps({"event": "fatal", "error": f"python dependency unavailable: {exc}"}), flush=True)
    raise


def iso_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def emit(event, **payload):
    data = {"event": event, "at": iso_now(), **payload}
    print(json.dumps(data, separators=(",", ":")), flush=True)


def build_messages():
    file_desc = descriptor_pb2.FileDescriptorProto()
    file_desc.name = "youtube_stream_list_probe.proto"
    file_desc.package = "youtube.api.v3"
    file_desc.syntax = "proto2"

    def add_message(name):
        msg = file_desc.message_type.add()
        msg.name = name
        return msg

    def add_field(msg, name, number, field_type, label=descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL, type_name=None):
        field = msg.field.add()
        field.name = name
        field.number = number
        field.type = field_type
        field.label = label
        if type_name:
            field.type_name = type_name
        return field

    req = add_message("LiveChatMessageListRequest")
    add_field(req, "live_chat_id", 1, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(req, "hl", 2, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(req, "profile_image_size", 3, descriptor_pb2.FieldDescriptorProto.TYPE_UINT32)
    add_field(req, "max_results", 98, descriptor_pb2.FieldDescriptorProto.TYPE_UINT32)
    add_field(req, "page_token", 99, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(req, "part", 100, descriptor_pb2.FieldDescriptorProto.TYPE_STRING, descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED)

    resp = add_message("LiveChatMessageListResponse")
    add_field(resp, "offline_at", 2, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(resp, "next_page_token", 100602, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(resp, "items", 1007, descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE, descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED, ".youtube.api.v3.LiveChatMessage")

    message = add_message("LiveChatMessage")
    add_field(message, "id", 101, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(message, "snippet", 2, descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE, type_name=".youtube.api.v3.LiveChatMessageSnippet")
    add_field(message, "author_details", 3, descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE, type_name=".youtube.api.v3.LiveChatMessageAuthorDetails")

    author = add_message("LiveChatMessageAuthorDetails")
    add_field(author, "channel_id", 10101, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(author, "display_name", 103, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(author, "is_chat_owner", 5, descriptor_pb2.FieldDescriptorProto.TYPE_BOOL)
    add_field(author, "is_chat_sponsor", 6, descriptor_pb2.FieldDescriptorProto.TYPE_BOOL)
    add_field(author, "is_chat_moderator", 7, descriptor_pb2.FieldDescriptorProto.TYPE_BOOL)

    snippet = add_message("LiveChatMessageSnippet")
    nested = snippet.nested_type.add()
    nested.name = "TypeWrapper"
    enum = nested.enum_type.add()
    enum.name = "Type"
    for name, number in (("INVALID_TYPE", 0), ("TEXT_MESSAGE_EVENT", 1), ("CHAT_ENDED_EVENT", 4)):
        value = enum.value.add()
        value.name = name
        value.number = number
    add_field(snippet, "type", 1, descriptor_pb2.FieldDescriptorProto.TYPE_ENUM, type_name=".youtube.api.v3.LiveChatMessageSnippet.TypeWrapper.Type")
    add_field(snippet, "live_chat_id", 201, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(snippet, "author_channel_id", 301, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(snippet, "published_at", 4, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(snippet, "display_message", 16, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)
    add_field(snippet, "text_message_details", 19, descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE, type_name=".youtube.api.v3.LiveChatTextMessageDetails")

    text_details = add_message("LiveChatTextMessageDetails")
    add_field(text_details, "message_text", 1, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)

    service = file_desc.service.add()
    service.name = "V3DataLiveChatMessageService"
    method = service.method.add()
    method.name = "StreamList"
    method.input_type = ".youtube.api.v3.LiveChatMessageListRequest"
    method.output_type = ".youtube.api.v3.LiveChatMessageListResponse"
    method.server_streaming = True

    pool = descriptor_pool.DescriptorPool()
    pool.Add(file_desc)
    req_cls = message_factory.GetMessageClass(pool.FindMessageTypeByName("youtube.api.v3.LiveChatMessageListRequest"))
    resp_cls = message_factory.GetMessageClass(pool.FindMessageTypeByName("youtube.api.v3.LiveChatMessageListResponse"))
    return req_cls, resp_cls


def metadata_to_map(metadata):
    result = {}
    try:
        for item in metadata or ():
            key = str(getattr(item, "key", "") or "")
            if not key:
                try:
                    key = str(item[0])
                except Exception:
                    continue
            result[key] = True
    except Exception:
        pass
    return sorted(result.keys())


def main():
    live_chat_id = str(os.environ.get("YOUTUBE_LIVE_CHAT_ID", "")).strip()
    access_token = str(os.environ.get("YOUTUBE_ACCESS_TOKEN", "")).strip()
    page_token = str(os.environ.get("YOUTUBE_PAGE_TOKEN", "")).strip()
    if not live_chat_id or not access_token:
        emit("fatal", error="missing live chat id or OAuth access token")
        return 2

    Request, Response = build_messages()
    channel = grpc.secure_channel("youtube.googleapis.com:443", grpc.ssl_channel_credentials())
    stream_list = channel.unary_stream(
        "/youtube.api.v3.V3DataLiveChatMessageService/StreamList",
        request_serializer=lambda value: value.SerializeToString(),
        response_deserializer=Response.FromString,
    )
    request = Request(live_chat_id=live_chat_id, part=["snippet", "authorDetails"], profile_image_size=16, max_results=200)
    if page_token:
        request.page_token = page_token

    call = None
    stopping = False

    def stop_handler(_signum, _frame):
        nonlocal stopping, call
        stopping = True
        try:
            if call is not None:
                call.cancel()
        except Exception:
            pass

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)

    emit("started", grpcVersion=getattr(grpc, "__version__", None))
    responses = 0
    messages = 0
    page_tokens = 0
    try:
        call = stream_list(request, metadata=(("authorization", f"Bearer {access_token}"),), wait_for_ready=False)
        for response in call:
            responses += 1
            item_count = len(response.items)
            messages += item_count
            if getattr(response, "next_page_token", ""):
                page_tokens += 1
            emit(
                "data",
                responseCount=responses,
                messageCount=messages,
                itemCount=item_count,
                pageTokenCount=page_tokens,
                hasNextPageToken=bool(getattr(response, "next_page_token", "")),
                nextPageToken=str(getattr(response, "next_page_token", "") or ""),
                offlineAt=str(getattr(response, "offline_at", "") or ""),
            )
            if getattr(response, "offline_at", ""):
                break

        code_obj = call.code() if call is not None else None
        code_name = getattr(code_obj, "name", None)
        code_value = getattr(code_obj, "value", None)
        if isinstance(code_value, tuple):
            code_value = code_value[0]
        details = call.details() if call is not None else ""
        trailers = metadata_to_map(call.trailing_metadata() if call is not None else None)
        emit("end", code=code_value, codeName=code_name, details=details or "", trailerKeys=trailers, stopped=stopping)
        return 0
    except grpc.RpcError as exc:
        code_obj = exc.code()
        code_name = getattr(code_obj, "name", None)
        code_value = getattr(code_obj, "value", None)
        if isinstance(code_value, tuple):
            code_value = code_value[0]
        try:
            trailers = metadata_to_map(exc.trailing_metadata())
        except Exception:
            trailers = []
        emit("error", code=code_value, codeName=code_name, details=str(exc.details() or ""), trailerKeys=trailers, stopped=stopping)
        return 0 if stopping else 1
    except Exception as exc:
        emit("error", code=None, codeName=None, details=str(exc), trailerKeys=[], stopped=stopping)
        return 0 if stopping else 1
    finally:
        try:
            channel.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
