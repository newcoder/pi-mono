"""Unit tests for local_data.market"""
import unittest

from local_data.market import (
    MARKET_BJ,
    MARKET_SH,
    MARKET_SZ,
    market_from_code,
    market_label,
    market_prefix,
)


class TestMarketFromCode(unittest.TestCase):
    def test_shanghai_main_board(self):
        for code in ["600519", "601318", "603288"]:
            self.assertEqual(market_from_code(code), MARKET_SH)

    def test_shanghai_star_market(self):
        for code in ["688981", "689009"]:
            self.assertEqual(market_from_code(code), MARKET_SH)

    def test_shenzhen_main_board(self):
        for code in ["000001", "000858", "002594"]:
            self.assertEqual(market_from_code(code), MARKET_SZ)

    def test_shenzhen_chinext(self):
        for code in ["300750", "301269"]:
            self.assertEqual(market_from_code(code), MARKET_SZ)

    def test_beijing(self):
        for code in ["430047", "830799", "920001"]:
            self.assertEqual(market_from_code(code), MARKET_BJ)

    def test_invalid_codes(self):
        for code in ["", "12345", "1234567", "abcdef", None]:
            self.assertIsNone(market_from_code(code))

    def test_b_share_legacy(self):
        self.assertEqual(market_from_code("900901"), MARKET_SH)
        self.assertEqual(market_from_code("200002"), MARKET_SZ)


class TestMarketLabel(unittest.TestCase):
    def test_labels(self):
        self.assertEqual(market_label("600519"), "SH")
        self.assertEqual(market_label("000001"), "SZ")
        self.assertEqual(market_label("430047"), "BJ")
        self.assertIsNone(market_label("999999"))


class TestMarketPrefix(unittest.TestCase):
    def test_lower(self):
        self.assertEqual(market_prefix("600519", "lower"), "sh600519")
        self.assertEqual(market_prefix("000001", "lower"), "sz000001")
        self.assertEqual(market_prefix("430047", "lower"), "bj430047")

    def test_upper(self):
        self.assertEqual(market_prefix("600519", "upper"), "SH600519")

    def test_dotted(self):
        self.assertEqual(market_prefix("600519", "dotted"), "600519.SH")

    def test_invalid(self):
        self.assertIsNone(market_prefix("999999"))
        with self.assertRaises(ValueError):
            market_prefix("600519", "unknown")


if __name__ == "__main__":
    unittest.main()
