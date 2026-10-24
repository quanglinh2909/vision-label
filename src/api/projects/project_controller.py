"""HTTP layer của module Project."""

from __future__ import annotations

from typing import Annotated

from fastapi import Path, status

from fastapi_modular.core.controller import controller, delete, get, patch, post
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.projects.dto.project_dto import ClassUsage, ProjectCreate, ProjectOut, ProjectUpdate
from src.api.projects.project_service import ProjectService

ProjectId = Annotated[str, Path(description="ID của project")]


@controller(prefix="/projects", tags=["projects"], guards=[Authenticated])
class ProjectController:
    def __init__(self, service: ProjectService) -> None:
        self._service = service

    @get("", response_model=list[ProjectOut], summary="Danh sách project")
    async def list_projects(self) -> list[ProjectOut]:
        return await self._service.list_projects(caller())

    @get("/{project_id}", response_model=ProjectOut, summary="Chi tiết project")
    async def get_project(self, project_id: ProjectId) -> ProjectOut:
        return await self._service.get_project(project_id, caller())

    @get("/{project_id}/class-usage", response_model=ClassUsage, guards=[AdminOnly], summary="Số nhãn đang dùng mỗi lớp")
    async def class_usage(self, project_id: ProjectId) -> ClassUsage:
        return await self._service.class_usage(project_id)

    @post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED, guards=[AdminOnly], summary="Tạo project")
    async def create_project(self, payload: ProjectCreate) -> ProjectOut:
        return await self._service.create_project(payload, caller())

    @patch("/{project_id}", response_model=ProjectOut, guards=[AdminOnly], summary="Sửa tên, lớp, mô tả")
    async def update_project(self, project_id: ProjectId, payload: ProjectUpdate) -> ProjectOut:
        return await self._service.update_project(project_id, payload, caller())

    @delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT, guards=[AdminOnly], summary="Xoá project")
    async def delete_project(self, project_id: ProjectId) -> None:
        await self._service.delete_project(project_id)
