"""Tests for DuckDuckGo-backed web search helpers."""

from __future__ import annotations

import unittest
import json
import urllib.error
from unittest.mock import MagicMock, patch

from app.subsystems.text.web_search import SEARCH_EMPTY, search_web


class WebSearchTests(unittest.TestCase):
    """Verify live-information search behavior."""

    @patch("app.subsystems.text.web_search._load_ddgs")
    def test_search_web_prefers_news_results(self, mock_load_ddgs) -> None:
        client = MagicMock()
        client.news.return_value = [{"title": "Latest headline", "body": "Important update."}]
        client.text.return_value = []
        ddgs_class = MagicMock()
        ddgs_class.return_value.__enter__.return_value = client
        mock_load_ddgs.return_value = ddgs_class

        result = search_web("latest news")

        self.assertEqual(result.source, "duckduckgo")
        self.assertIn("Latest headline", result.context)
        client.news.assert_called_once()
        client.text.assert_not_called()

    @patch("app.subsystems.text.web_search._load_ddgs")
    def test_search_web_falls_back_to_text_results(self, mock_load_ddgs) -> None:
        client = MagicMock()
        client.news.return_value = []
        client.text.return_value = [{"title": "Result title", "snippet": "Result snippet."}]
        ddgs_class = MagicMock()
        ddgs_class.return_value.__enter__.return_value = client
        mock_load_ddgs.return_value = ddgs_class

        result = search_web("find recent benchmarks")

        self.assertEqual(result.source, "duckduckgo")
        self.assertIn("Result title", result.context)
        client.text.assert_called_once()

    @patch("app.subsystems.text.web_search._load_ddgs")
    def test_search_web_rewrites_person_age_queries(self, mock_load_ddgs) -> None:
        client = MagicMock()
        client.news.return_value = []
        client.text.return_value = [{"title": "Shadow Stevens", "snippet": "Born November 1946."}]
        ddgs_class = MagicMock()
        ddgs_class.return_value.__enter__.return_value = client
        mock_load_ddgs.return_value = ddgs_class

        result = search_web("how old is shadow stevens")

        self.assertEqual(result.source, "duckduckgo")
        self.assertEqual(result.query, '"shadow stevens" age')
        self.assertIn("Shadow Stevens", result.context)
        self.assertEqual(client.text.call_args.args[0], '"shadow stevens" age')
        self.assertEqual(result.metadata["kind"], "person_age")
        self.assertEqual(result.metadata["name"], "shadow stevens")

    @patch("app.subsystems.text.web_search._load_ddgs")
    def test_search_web_rewrites_president_queries(self, mock_load_ddgs) -> None:
        client = MagicMock()
        client.news.return_value = []
        client.text.return_value = [{"title": "President of the United States", "snippet": "Donald Trump is the current president of the United States."}]
        ddgs_class = MagicMock()
        ddgs_class.return_value.__enter__.return_value = client
        mock_load_ddgs.return_value = ddgs_class

        result = search_web("who is president")

        self.assertEqual(result.source, "duckduckgo")
        self.assertEqual(result.query, "current president of the united states")
        self.assertEqual(client.text.call_args.args[0], "current president of the united states")
        self.assertEqual(result.metadata["kind"], "office_holder")
        self.assertEqual(result.metadata["office"], "President of the United States")

    @patch("urllib.request.urlopen")
    def test_search_web_uses_wttr_for_weather(self, mock_urlopen) -> None:
        response = MagicMock()
        response.read.return_value = json.dumps(
            {
                "current_condition": [
                    {
                        "temp_F": "72",
                        "FeelsLikeF": "70",
                        "windspeedMiles": "9",
                        "winddir16Point": "NW",
                        "weatherDesc": [{"value": "Sunny"}],
                    }
                ],
                "weather": [
                    {
                        "maxtempF": "75",
                        "mintempF": "60",
                        "hourly": [
                            {"chanceofrain": "10"},
                            {"chanceofrain": "35"},
                        ],
                    }
                ],
            }
        ).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = response

        result = search_web("weather in Austin")

        self.assertEqual(result.source, "wttr.in")
        self.assertIn("Austin".lower(), result.context.lower())
        self.assertEqual(result.metadata["high_temp_f"], "75")
        self.assertEqual(result.metadata["low_temp_f"], "60")
        self.assertEqual(result.metadata["chance_of_rain"], "22")
        self.assertEqual(result.metadata["peak_chance_of_rain"], "35")

    @patch("urllib.request.urlopen")
    def test_search_web_retries_wttr_once_before_fallback(self, mock_urlopen) -> None:
        response = MagicMock()
        response.read.return_value = json.dumps(
            {
                "current_condition": [
                    {
                        "temp_F": "72",
                        "FeelsLikeF": "70",
                        "windspeedMiles": "9",
                        "winddir16Point": "NW",
                        "weatherDesc": [{"value": "Sunny"}],
                    }
                ],
                "weather": [
                    {
                        "maxtempF": "75",
                        "mintempF": "60",
                        "hourly": [
                            {"chanceofrain": "10"},
                            {"chanceofrain": "35"},
                        ],
                    }
                ],
            }
        ).encode("utf-8")
        success_context = MagicMock()
        success_context.__enter__.return_value = response
        success_context.__exit__.return_value = False
        mock_urlopen.side_effect = [
            urllib.error.HTTPError(
                url="https://wttr.in/local?format=j1",
                code=500,
                msg="Internal Server Error",
                hdrs=None,
                fp=None,
            ),
            success_context,
        ]

        result = search_web("weather in Austin")

        self.assertEqual(result.source, "wttr.in")
        self.assertEqual(mock_urlopen.call_count, 2)
        self.assertEqual(result.metadata["high_temp_f"], "75")

    @patch("app.subsystems.text.web_search._load_ddgs", return_value=None)
    def test_search_web_reports_missing_library(self, _mock_load_ddgs) -> None:
        result = search_web("latest headlines")
        self.assertEqual(result.context, "SEARCH_ERROR")

    @patch("app.subsystems.text.web_search._load_ddgs")
    def test_search_web_reports_empty_results(self, mock_load_ddgs) -> None:
        client = MagicMock()
        client.news.return_value = []
        client.text.return_value = []
        ddgs_class = MagicMock()
        ddgs_class.return_value.__enter__.return_value = client
        mock_load_ddgs.return_value = ddgs_class

        result = search_web("obscure query")

        self.assertEqual(result.context, SEARCH_EMPTY)


if __name__ == "__main__":
    unittest.main()
