"""
project_agent/openai_compat/urls.py
Mount in your project's urls.py:
    path("openai/v1/", include("project_agent.openai_compat.urls")),
"""
from django.urls import path
from .views import OpenAIChatCompletionsView, OpenAIModelsView

urlpatterns = [
    path("chat/completions", OpenAIChatCompletionsView.as_view(), name="openai-chat"),
    path("models",           OpenAIModelsView.as_view(),          name="openai-models"),
]
